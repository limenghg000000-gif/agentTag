import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { CardAnswerStore } from "../src/card-answers.js";

const dirs: string[] = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "card-answers-"));
  dirs.push(dir);
  return path.join(dir, "card-answers");
}

test("按群记下卡片里的回答，重启后照样读得到；每个群只留最近的若干条", async () => {
  const dir = await tempDir();
  const store = new CardAnswerStore(dir, 2);

  await store.save("oc_1", "om_a", "回答 A");
  await store.save("oc_1", "om_b", "回答 B");
  await store.save("oc_2", "om_x", "别的群");
  await store.save("oc_1", "om_c", "回答 C");

  assert.deepEqual([...(await store.get("oc_1", ["om_a", "om_b", "om_c", "om_x"]))], [
    ["om_b", "回答 B"],
    ["om_c", "回答 C"],
  ]);
  const reopened = new CardAnswerStore(dir, 2);
  assert.deepEqual([...(await reopened.get("oc_1", ["om_c", "om_a"]))], [["om_c", "回答 C"]]);
  assert.deepEqual([...(await reopened.get("oc_2", ["om_x"]))], [["om_x", "别的群"]]);
  assert.deepEqual([...(await reopened.get("oc_3", ["om_x"]))], []);
  assert.deepEqual((await readdir(dir)).sort(), ["oc_1.json", "oc_2.json"]);
});

test("同时记几条不会互相覆盖；chat_id 格式不对时不拼文件名", async () => {
  const dir = await tempDir();
  const store = new CardAnswerStore(dir);

  await Promise.all(Array.from({ length: 10 }, (_, i) => store.save("oc_1", `om_${i}`, `回答 ${i}`)));

  const saved = JSON.parse(await readFile(path.join(dir, "oc_1.json"), "utf8"));
  assert.equal(Object.keys(saved).length, 10);
  await assert.rejects(store.save("../oc_1", "om_1", "x"), /chat_id 格式不对/);
  await assert.rejects(store.get("oc/1", ["om_1"]), /chat_id 格式不对/);
});

test("文件坏了时挪到 .bad 留着，从空的重新记", async () => {
  const dir = await tempDir();
  const store = new CardAnswerStore(dir);
  await store.save("oc_1", "om_1", "回答");
  await writeFile(path.join(dir, "oc_2.json"), "{坏了");

  assert.deepEqual([...(await store.get("oc_2", ["om_1"]))], []);
  await store.save("oc_2", "om_2", "新的");
  assert.equal(await readFile(path.join(dir, "oc_2.json.bad"), "utf8"), "{坏了");
  assert.deepEqual([...(await new CardAnswerStore(dir).get("oc_2", ["om_2"]))], [["om_2", "新的"]]);
});
