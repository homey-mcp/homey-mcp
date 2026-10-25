#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";

// One entry for both protocol generations: the opening exchange selects
// 2026-07-28 (server/discover) or the 2025-era initialize handshake.
serveStdio(() => createServer());
