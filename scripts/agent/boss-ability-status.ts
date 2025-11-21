#!/usr/bin/env node
import { formatBossAbilityStatusReport } from './boss-ability-status-lib.js';

process.stdout.write(formatBossAbilityStatusReport());
