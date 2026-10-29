#!/usr/bin/env node
// Embute uma logo PNG no template do criativo: node scripts/logo.mjs caminho/da/logo.png
import { readFileSync, writeFileSync } from "node:fs";
const caminho = process.argv[2];
if (!caminho) { console.error("uso: node scripts/logo.mjs caminho/da/logo.png"); process.exit(1); }
const b64 = readFileSync(caminho).toString("base64");
writeFileSync(new URL("../src/agentes/templates/logo.ts", import.meta.url), `/** Logo embutida no criativo (gerado por scripts/logo.mjs a partir de ${caminho.split("/").pop()}). */\nexport const LOGO_DATA_URI = "data:image/png;base64,${b64}";\n`);
console.log("logo embutida:", Math.round(b64.length / 1024), "KB");
