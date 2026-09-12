#!/usr/bin/env python3
"""Register or remove the AgentPulse custom Channel in Claude Code."""
from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

CHANNEL = Path(__file__).resolve().parent.parent / 'claude-channel' / 'agentpulse-channel.mjs'


def add_server(data, node_path, script):
    if not isinstance(data, dict):
        raise ValueError('Claude configuration root must be a JSON object.')
    result=copy.deepcopy(data)
    servers=result.setdefault('mcpServers',{})
    if not isinstance(servers,dict):
        raise ValueError("Claude configuration 'mcpServers' must be an object.")
    servers['agentpulse']={'type':'stdio','command':str(Path(node_path).resolve()),'args':[str(Path(script).resolve())]}
    return result


def remove_server(data):
    if not isinstance(data,dict):
        raise ValueError('Claude configuration root must be a JSON object.')
    result=copy.deepcopy(data)
    servers=result.get('mcpServers')
    if servers is None:
        return result
    if not isinstance(servers,dict):
        raise ValueError("Claude configuration 'mcpServers' must be an object.")
    servers.pop('agentpulse',None)
    if not servers:
        result.pop('mcpServers',None)
    return result


def read_config(file):
    if file.is_symlink():
        raise ValueError('Claude configuration is a symlink and requires manual installation.')
    if not file.exists():
        return {}
    try:
        value=json.loads(file.read_text(encoding='utf-8'))
    except (OSError,ValueError,UnicodeError):
        raise ValueError('Claude configuration is not valid JSON.') from None
    if not isinstance(value,dict):
        raise ValueError('Claude configuration root must be a JSON object.')
    return value


def write_config(file,value):
    file.parent.mkdir(parents=True,exist_ok=True)
    fd,temporary=tempfile.mkstemp(prefix='.agentpulse-claude-',dir=str(file.parent))
    try:
        with os.fdopen(fd,'w',encoding='utf-8') as handle:
            json.dump(value,handle,indent=2,ensure_ascii=False)
            handle.write('\n');handle.flush();os.fsync(handle.fileno())
        os.chmod(temporary,0o600)
        os.replace(temporary,file);file.chmod(0o600)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def backup(file,stamp):
    if not file.exists():
        return None
    destination=file.with_name(file.name+'.agentpulse-channel-backup-'+stamp)
    shutil.copy2(file,destination);destination.chmod(0o600)
    return destination


def validate_runtime(node_path,script,runner=subprocess.run):
    node=Path(node_path).expanduser().resolve()
    channel=Path(script).expanduser().resolve()
    if not channel.is_file():
        raise ValueError('AgentPulse Channel script was not found in this checkout.')
    if not node.is_file():
        raise ValueError('Node 22 or newer was not found.')
    try:
        version=runner([str(node),'--version'],check=True,capture_output=True,text=True,timeout=5).stdout.strip()
        major=int(version.lstrip('v').split('.',1)[0])
    except (OSError,ValueError,subprocess.SubprocessError,AttributeError):
        raise ValueError('Could not verify the Node runtime.') from None
    if major<22:
        raise ValueError('Node 22 or newer is required for AgentPulse Channel.')
    return node,channel


def install(home=Path.home(),node_path=None,script=CHANNEL,stamp=None,runner=subprocess.run):
    config=Path(home)/'.claude.json'
    data=read_config(config)
    executable=node_path or shutil.which('node')
    if not executable:
        raise ValueError('Node 22 or newer was not found.')
    node,channel=validate_runtime(executable,script,runner)
    updated=add_server(data,node,channel)
    timestamp=stamp or time.strftime('%Y%m%d-%H%M%S')
    saved=backup(config,timestamp)
    write_config(config,updated)
    if saved:print('Backup:',saved)
    print('AgentPulse Claude Channel registered in',config)
    print('Start a new Claude Code session with:')
    print('claude --dangerously-load-development-channels server:agentpulse')
    print('Review the AgentPulse channel trust prompt. Existing Claude permissions are unchanged.')


def uninstall(home=Path.home(),stamp=None):
    config=Path(home)/'.claude.json'
    data=read_config(config)
    updated=remove_server(data)
    timestamp=stamp or time.strftime('%Y%m%d-%H%M%S')
    saved=backup(config,timestamp)
    write_config(config,updated)
    if saved:print('Backup:',saved)
    print('AgentPulse Claude Channel removed from',config)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['install','uninstall'])
    args=parser.parse_args()
    if args.action=='install':install()
    else:uninstall()


if __name__=='__main__':
    try:main()
    except (ValueError,OSError) as error:raise SystemExit('AgentPulse: '+str(error))
