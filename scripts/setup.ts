import { writeFileSync } from "node:fs";

const admin = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const key = crypto.randomUUID().replaceAll("-", "");
try {
  writeFileSync(".env", `ADMIN_TOKEN=${admin}\nSENTRY_PROJECTS={"1":"${key}"}\nDB_PATH=./data/tiny-sentry.sqlite\n`, { flag: "wx", mode: 0o600 });
  console.log("Created .env with random credentials. Start with: bun start");
  console.log(`Local Sentry DSN: http://${key}@localhost:3000/1`);
  console.log("For Railway, copy ADMIN_TOKEN and SENTRY_PROJECTS from .env into service variables.");
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "EEXIST") {
    console.error(".env already exists; keeping your credentials.");
    process.exitCode = 1;
  } else throw error;
}
