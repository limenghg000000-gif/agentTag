import { readFileSync } from "node:fs";

/** 程序的版本号，以 package.json 为准（和 CHANGELOG.md 最上面那一版一样）。src 和 dist 都在项目根目录下一层 */
export const VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
