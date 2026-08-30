// scripts/deploy.mjs
// Deploy estático (sin build) a cPanel (vicbas.com) vía FTP/FTPS.
// Uso:  npm install  &&  npm run deploy
//
// Corre automáticamente al pushear a main (hook .githooks/pre-push);
// saltarlo puntualmente:  git push --no-verify
//
// Recorre TODO el repo y sube archivo por archivo (uploadFrom + ensureDir).
// NUNCA borra nada del servidor (no usa syncToRemote).
//
// Archivos .env (en este orden, gana el último; jamás se loguean valores):
//   1) ../.env  → .env CENTRAL del directorio padre (credenciales universales)
//   2) ./.env   → .env local del repo (p.ej. SMTP en mbti)
//   3) process.env
//
// Claves por página (prefijo PAGE) con fallback universal FTP_*
// (cadena vacía = no seteado → cae al fallback):
//   <PAGINA>_HOST / FTP_HOST
//   <PAGINA>_PORT / FTP_PORT (default 21)
//   <PAGINA>_USERNAME / FTP_USERNAME
//   <PAGINA>_PASSWORD / FTP_PASSWORD
//   <PAGINA>_REMOTE_DIR / FTP_REMOTE_DIR
//   <PAGINA>_SECURE / FTP_SECURE ("false" = FTP plano; por defecto FTPS)
//
// Excluidos del recorrido:
//   - directorios (por nombre, a cualquier profundidad): .git, .github,
//     .githooks, node_modules, .atl, .pi, .pi-subagents, .vscode, scripts,
//     openspec, _ds, uploads
//   - archivos (por nombre): .env, .env.example, env.example.txt, package.json,
//     package-lock.json, .gitignore, README.md, .DS_Store, .thumbnail
//   - cualquier otro nombre que empiece con "." salvo .htaccess y el
//     directorio .well-known
//   - glob "*.backup"
//
// Si PROVISION_REMOTE_ENV está activo (sólo mbti), al final además se sube el
// .env del repo como ${REMOTE}/.env (lo lee send_result.php en el servidor).

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as ftp from "basic-ftp";

// --- Esta página (única diferencia entre los 4 repos) -----------------------
const PAGE = "DOTS";
const PROVISION_REMOTE_ENV = false;

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const centralEnv = join(root, "..", ".env"); // .env central (fuera del repo)
const repoEnv = join(root, ".env"); // .env local del repo

// --- Parseo manual de .env (sin dependencias) --------------------------------
function loadEnv(file) {
	if (!existsSync(file)) return {};
	return Object.fromEntries(
		readFileSync(file, "utf8")
			.split("\n")
			.filter((l) => l && !l.trim().startsWith("#") && l.includes("="))
			.map((l) => {
				const i = l.indexOf("=");
				return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
			}),
	);
}

// Precedencia: central → repo → process.env (gana el último).
const env = { ...loadEnv(centralEnv), ...loadEnv(repoEnv), ...process.env };
const envFiles = [centralEnv, repoEnv].filter((f) => existsSync(f));

// --- Resolución de credenciales (vacío = no seteado → fallback) --------------
const pick = (k) => (env[k] && env[k].trim() !== "" ? env[k] : undefined);
const HOST = pick(`${PAGE}_HOST`) ?? pick("FTP_HOST");
const PORT = Number(pick(`${PAGE}_PORT`) ?? pick("FTP_PORT") ?? 21);
const USER = pick(`${PAGE}_USERNAME`) ?? pick("FTP_USERNAME");
const PASS = pick(`${PAGE}_PASSWORD`) ?? pick("FTP_PASSWORD");
const REMOTE = pick(`${PAGE}_REMOTE_DIR`) ?? pick("FTP_REMOTE_DIR");
const SECURE =
	String(pick(`${PAGE}_SECURE`) ?? pick("FTP_SECURE") ?? "true") !== "false";

const missing = [
	["HOST", HOST],
	["USERNAME", USER],
	["PASSWORD", PASS],
	["REMOTE_DIR", REMOTE],
]
	.filter(([, v]) => !v)
	.map(([k]) => k);
if (missing.length) {
	console.error(
		`❌ [${PAGE}] Faltan credenciales de deploy: ${missing.join(", ")}.`,
	);
	console.error("   Archivos .env buscados (gana el último):");
	console.error(`     1. ${centralEnv}`);
	console.error(`     2. ${repoEnv}`);
	console.error("     3. process.env");
	console.error(
		"   Completá FTP_USERNAME / FTP_PASSWORD en el .env central y volvé a correr el deploy.",
	);
	process.exit(1);
}

// --- Recorrido del repo (sube todo; nunca borra en el servidor) --------------
const EXCLUDED_DIRS = new Set([
	".git",
	".github",
	".githooks",
	"node_modules",
	".atl",
	".pi",
	".pi-subagents",
	".vscode",
	"scripts",
	"openspec",
	"_ds",
	"uploads",
]);
const EXCLUDED_FILES = new Set([
	".env",
	".env.example",
	"env.example.txt",
	"package.json",
	"package-lock.json",
	".gitignore",
	"README.md",
	".DS_Store",
	".thumbnail",
]);
// Nombres con punto permitidos: el .htaccess público y el dir .well-known.
const DOT_ALLOWED = new Set([".htaccess", ".well-known"]);

function excluded(name, isDir) {
	if (isDir ? EXCLUDED_DIRS.has(name) : EXCLUDED_FILES.has(name)) return true;
	if (name.endsWith(".backup")) return true;
	if (name.startsWith(".") && !DOT_ALLOWED.has(name)) return true;
	return false;
}

let skipped = 0;
function walk(dir, prefix) {
	const out = [];
	const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name),
	);
	for (const ent of entries) {
		const isDir = ent.isDirectory();
		if (excluded(ent.name, isDir)) {
			skipped += 1;
			continue;
		}
		const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
		if (isDir) out.push(...walk(join(dir, ent.name), rel));
		else if (ent.isFile()) out.push(rel);
	}
	return out;
}
const files = walk(root, "");

// Utilidades POSIX (el remoto siempre usa "/", sin importar el SO local).
function posixDir(rel) {
	const i = rel.lastIndexOf("/");
	return i === -1 ? "" : rel.slice(0, i);
}
function joinPosix(a, b) {
	return b ? `${a}/${b}` : a;
}

const client = new ftp.Client(60000);
client.ftp.verbose = false;

function log(msg) {
	console.log(`  ${msg}`);
}

async function main() {
	console.log(`\n🚀 Deploy ${PAGE} → ${HOST} ${REMOTE}`);
	console.log(`   Modo: ${SECURE ? "FTPS (TLS)" : "FTP plano"}`);
	console.log(
		`   .env encontrados: ${
			envFiles.length ? envFiles.join(", ") : "(ninguno; sólo process.env)"
		}`,
	);
	console.log(`   Archivos a subir: ${files.length}\n`);

	log(`Conectando a ${HOST}:${PORT}…`);
	await client.access({
		host: HOST,
		port: PORT,
		user: USER,
		password: PASS,
		secure: SECURE,
		secureOptions: { rejectUnauthorized: false }, // cert autofirmado de cPanel
	});
	await client.ensureDir(REMOTE);

	let uploaded = 0;
	for (const rel of files) {
		await client.ensureDir(joinPosix(REMOTE, posixDir(rel)));
		await client.uploadFrom(join(root, rel), joinPosix(REMOTE, rel));
		uploaded += 1;
		log(`✓ ${rel}`);
	}

	// Provisionar el .env del repo en la raíz remota (sólo mbti).
	if (PROVISION_REMOTE_ENV && existsSync(repoEnv)) {
		log(`Provisionando .env del repo en ${REMOTE}/.env…`);
		await client.ensureDir(REMOTE);
		await client.uploadFrom(repoEnv, `${REMOTE}/.env`);
		uploaded += 1;
		log("✓ .env (provisionado)");
	}

	console.log(
		`\n✅ Deploy completo: ${uploaded} archivos subidos, ${skipped} saltados.\n`,
	);
	client.close();
}

main().catch((e) => {
	console.error("\n❌ Error en el deploy:", e.message ?? e);
	try {
		client.close();
	} catch {}
	process.exit(1);
});
