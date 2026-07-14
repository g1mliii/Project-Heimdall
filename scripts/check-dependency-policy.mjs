import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const minAgeDays = Number.parseInt(process.env.DEPENDENCY_MIN_AGE_DAYS ?? "30", 10);
const minimumAgeExceptions = packageJson.dependencyPolicy?.minimumAgeExceptions ?? {};
const now = new Date();
const failures = [];
const warnings = [];

async function fetchPackageMetadata(name) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`registry returned ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function parsePackageManager(value) {
  const match = /^([^@]+)@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/.exec(value ?? "");
  if (!match) {
    failures.push(`packageManager must be an exact package@version pin, got ${JSON.stringify(value)}.`);
    return null;
  }

  return { name: match[1], version: match[2], source: "packageManager" };
}

function parseExactDependency(name, versionRange, source) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(versionRange)) {
    failures.push(`${source}.${name} must be an exact version pin, got ${JSON.stringify(versionRange)}.`);
    return null;
  }

  return { name, version: versionRange, source };
}

// Workspace package manifests (apps/*, packages/*) so their pins are held to the
// same exact-pin + 30-day soak policy as the root, not just the root itself.
function discoverWorkspaceManifests() {
  const manifests = [];
  for (const group of ["apps", "packages"]) {
    let entries;
    try {
      entries = readdirSync(join(rootDir, group), { withFileTypes: true });
    } catch {
      continue; // group not scaffolded yet
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const manifestPath = join(rootDir, group, entry.name, "package.json");
      try {
        manifests.push({ path: manifestPath, json: JSON.parse(readFileSync(manifestPath, "utf8")) });
      } catch {
        // No package.json (e.g. a .gitkeep-only stub) — nothing to validate.
      }
    }
  }
  return manifests;
}

function collectDependencies() {
  const dependencies = [];
  const packageManager = parsePackageManager(packageJson.packageManager);
  if (packageManager) {
    dependencies.push(packageManager);
  }

  const manifests = [
    { label: "", json: packageJson },
    ...discoverWorkspaceManifests().map((m) => ({
      label: `${relative(rootDir, dirname(m.path)).replace(/\\/g, "/")}:`,
      json: m.json,
    })),
  ];

  for (const { label, json } of manifests) {
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, versionRange] of Object.entries(json[section] ?? {})) {
        // Workspace-internal links (workspace:*) are not registry packages.
        if (typeof versionRange === "string" && versionRange.startsWith("workspace:")) {
          continue;
        }
        const dependency = parseExactDependency(name, versionRange, `${label}${section}`);
        if (dependency) {
          dependencies.push(dependency);
        }
      }
    }
  }

  return dependencies;
}

function major(version) {
  return Number.parseInt(version.split(".")[0], 10);
}

function ageInDays(date) {
  return Math.floor((now.getTime() - date.getTime()) / 86_400_000);
}

async function validateDependency(dependency) {
  let metadata;

  try {
    metadata = await fetchPackageMetadata(dependency.name);
  } catch (error) {
    failures.push(`${dependency.source}.${dependency.name}@${dependency.version}: npm registry lookup failed (${error.message}).`);
    return;
  }

  const releaseTime = metadata.time?.[dependency.version];
  if (!releaseTime) {
    failures.push(`${dependency.source}.${dependency.name}@${dependency.version}: release timestamp not found in npm registry.`);
    return;
  }

  const releaseDate = new Date(releaseTime);
  const releaseAgeDays = ageInDays(releaseDate);
  if (releaseAgeDays < minAgeDays) {
    const exceptionKey = `${dependency.name}@${dependency.version}`;
    const exception = minimumAgeExceptions[exceptionKey];
    if (typeof exception === "string" && exception.trim().length > 0) {
      warnings.push(
        `${dependency.source}.${exceptionKey}: released ${releaseAgeDays} days ago; minimum-age exception: ${exception}`,
      );
    } else {
      failures.push(
        `${dependency.source}.${exceptionKey}: released ${releaseAgeDays} days ago; minimum soak is ${minAgeDays} days unless a security exception is documented.`,
      );
    }
  }

  const versionMetadata = metadata.versions?.[dependency.version];
  if (versionMetadata?.deprecated) {
    failures.push(`${dependency.source}.${dependency.name}@${dependency.version}: deprecated by npm registry: ${versionMetadata.deprecated}`);
  }

  const latest = metadata["dist-tags"]?.latest;
  if (latest && major(latest) > major(dependency.version)) {
    const latestTime = metadata.time?.[latest];
    if (latestTime && ageInDays(new Date(latestTime)) >= minAgeDays) {
      warnings.push(
        `${dependency.source}.${dependency.name}@${dependency.version}: latest stable major is ${latest}; confirm this older major is intentional.`,
      );
    }
  }
}

const dependencies = collectDependencies();
const dependencyKeys = new Set(dependencies.map(({ name, version }) => `${name}@${version}`));
for (const [key, reason] of Object.entries(minimumAgeExceptions)) {
  if (!dependencyKeys.has(key)) {
    failures.push(`dependencyPolicy.minimumAgeExceptions.${key}: no matching pinned dependency.`);
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    failures.push(`dependencyPolicy.minimumAgeExceptions.${key}: reason must be non-empty.`);
  }
}

for (const dependency of dependencies) {
  await validateDependency(dependency);
}

if (warnings.length > 0) {
  console.warn(warnings.map((warning) => `warning: ${warning}`).join("\n"));
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `error: ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Dependency policy check passed (${minAgeDays}-day minimum release age).`);
