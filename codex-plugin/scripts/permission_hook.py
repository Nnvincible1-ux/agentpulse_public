#!/usr/bin/env python3
import sys
import agentpulse_hook

sys.argv = [sys.argv[0], "codex", "permission"]
raise SystemExit(agentpulse_hook.main())
