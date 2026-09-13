#!/usr/bin/env python3
"""Register or remove the AgentPulse custom Channel in Claude Code."""
from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import time

CHANNEL = Path(__file__).resolve().parent.parent / 'claude-channel' / 'agentpulse-channel.mjs'
SHELL_BEGIN = '# >>> AgentPulse Claude Channel >>>'
SHELL_END = '# <<< AgentPulse Claude Channel <<<'


def remove_shell_default(content):
    start=content.find(SHELL_BEGIN)
    if start<0:
        return content
    end=content.find(SHELL_END,start)
    if end<0:
        raise ValueError('AgentPulse shell block is incomplete and requires manual repair.')
    end+=len(SHELL_END)
    if end<len(content) and content[end]=='\n':
        end+=1
    return content[:start]+content[end:]


def add_shell_default(content,claude_path):
    clean=remove_shell_default(content)
    prefix=clean if not clean or clean.endswith('\n') else clean+'\n'
    executable=shlex.quote(str(claude_path))
    block=(f'{SHELL_BEGIN}\n'
           'claude() {\n'
           f'  command {executable} --dangerously-load-development-channels server:agentpulse "$@"\n'
           '}\n'
           f'{SHELL_END}\n')
    return prefix+block


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


def write_text(file,value,mode):
    file.parent.mkdir(parents=True,exist_ok=True)
    fd,temporary=tempfile.mkstemp(prefix='.agentpulse-claude-',dir=str(file.parent))
    try:
        with os.fdopen(fd,'w',encoding='utf-8') as handle:
            handle.write(value);handle.flush();os.fsync(handle.fileno())
        os.chmod(temporary,mode)
        os.replace(temporary,file);file.chmod(mode)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def write_config(file,value):
    write_text(file,json.dumps(value,indent=2,ensure_ascii=False)+'\n',0o600)


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


def install(home=Path.home(),node_path=None,script=CHANNEL,stamp=None,runner=subprocess.run,shell_default=False,claude_path=None):
    config=Path(home)/'.claude.json'
    config_existed=config.exists()
    data=read_config(config)
    executable=node_path or shutil.which('node')
    if not executable:
        raise ValueError('Node 22 or newer was not found.')
    node,channel=validate_runtime(executable,script,runner)
    updated=add_server(data,node,channel)
    shell=None;shell_content=None;shell_mode=None
    if shell_default:
        claude_executable=Path(claude_path or shutil.which('claude') or '')
        if not claude_executable.is_file() or not os.access(claude_executable,os.X_OK):
            raise ValueError('Claude Code executable was not found.')
        shell=Path(home)/'.zshrc'
        if shell.is_symlink():
            raise ValueError('The zsh configuration is a symlink and requires manual setup.')
        existing=shell.read_text(encoding='utf-8') if shell.exists() else ''
        shell_content=add_shell_default(existing,claude_executable.absolute())
        shell_mode=(shell.stat().st_mode&0o777) if shell.exists() else 0o600
    timestamp=stamp or time.strftime('%Y%m%d-%H%M%S')
    saved=backup(config,timestamp)
    shell_backup=backup(shell,timestamp) if shell is not None else None
    try:
        write_config(config,updated)
        if shell is not None:
            write_text(shell,shell_content,shell_mode)
    except Exception:
        if config_existed:write_config(config,data)
        elif config.exists():config.unlink()
        raise
    if saved:print('Backup:',saved)
    if shell_backup:print('Backup:',shell_backup)
    print('AgentPulse Claude Channel registered in',config)
    print('Open a new terminal and start a new Claude Code session with:')
    print('claude' if shell_default else 'claude --dangerously-load-development-channels server:agentpulse')
    print('Review the AgentPulse channel trust prompt. Existing Claude permissions are unchanged.')


def uninstall(home=Path.home(),stamp=None):
    config=Path(home)/'.claude.json'
    data=read_config(config)
    updated=remove_server(data)
    timestamp=stamp or time.strftime('%Y%m%d-%H%M%S')
    saved=backup(config,timestamp)
    write_config(config,updated)
    if saved:print('Backup:',saved)
    shell=Path(home)/'.zshrc'
    if shell.exists() and not shell.is_symlink():
        existing=shell.read_text(encoding='utf-8')
        cleaned=remove_shell_default(existing)
        if cleaned!=existing:
            saved_shell=backup(shell,timestamp)
            write_text(shell,cleaned,shell.stat().st_mode&0o777)
            if saved_shell:print('Backup:',saved_shell)
    print('AgentPulse Claude Channel removed from',config)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['install','uninstall'])
    parser.add_argument('--shell-default',action='store_true',help='Make new zsh sessions opt in when you run claude.')
    args=parser.parse_args()
    if args.action=='install':install(shell_default=args.shell_default)
    else:uninstall()


if __name__=='__main__':
    try:main()
    except (ValueError,OSError) as error:raise SystemExit('AgentPulse: '+str(error))
