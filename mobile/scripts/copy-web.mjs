// Copies the web app into mobile/www so Capacitor can bundle it. Run from mobile/.
import { cpSync, mkdirSync, rmSync } from "node:fs";
rmSync("www", { recursive: true, force: true });
mkdirSync("www", { recursive: true });
for (const f of ["index.html", "manifest.webmanifest", "sw.js"]) cpSync(`../${f}`, `www/${f}`);
cpSync("../icons", "www/icons", { recursive: true });
console.log("web assets copied to mobile/www");
