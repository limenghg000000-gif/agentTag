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

test("按话题记下卡片里的回答，重启后照样读得到；每个话题只留最近的若干条，别的话题再多也挤不掉", async () => {
  const dir = await tempDir();
  const store = new CardAnswerStore(dir, 2);

  await store.save("oc_1", "om_old", "om_a", "老话题的回答");
  await store.save("oc_1", "om_root", "om_b", "回答 B");
  await store.save("oc_1", "om_root", "om_c", "回答 C");
  await store.save("oc_1", "om_root", "om_d", "回答 D");
  await store.save("oc_1", "om_other", "om_e", "别的话题");
  await store.save("oc_1", "om_other", "om_f", "别的话题");
  await store.save("oc_2", "om_root", "om_x", "别的群");

  assert.deepEqual([...(await store.get("oc_1", "om_root", ["om_a", "om_b", "om_c", "om_d", "om_x"]))], [
    ["om_c", "回答 C"],
    ["om_d", "回答 D"],
  ]);
  const reopened = new CardAnswerStore(dir, 2);
  assert.deepEqual([...(await reopened.get("oc_1", "om_old", ["om_a"]))], [["om_a", "老话题的回答"]]);
  assert.deepEqual([...(await reopened.get("oc_1", "om_root", ["om_d", "om_b"]))], [["om_d", "回答 D"]]);
  assert.deepEqual([...(await reopened.get("oc_2", "om_root", ["om_x"]))], [["om_x", "别的群"]]);
  assert.deepEqual([...(await reopened.get("oc_3", "om_root", ["om_x"]))], []);
  assert.deepEqual((await readdir(path.join(dir, "oc_1"))).sort(), ["om_old.json", "om_other.json", "om_root.json"]);
});

test("同时记几条、边记边读不会互相覆盖；id 格式不对时不拼路径", async () => {
  const dir = await tempDir();
  const store = new CardAnswerStore(dir);

  const reads: Promise<Map<string, string>>[] = [];
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => {
      const saved = store.save("oc_1", "om_root", `om_${i}`, `回答 ${i}`);
      reads.push(store.get("oc_1", "om_root", [`om_${i}`]));
      return saved;
    }),
  );

  const saved = JSON.parse(await readFile(path.join(dir, "oc_1", "om_root.json"), "utf8"));
  assert.equal(Object.keys(saved).length, 10);
  assert.deepEqual(
    (await Promise.all(reads)).map((found) => [...found.values()]),
    Array.from({ length: 10 }, (_, i) => [`回答 ${i}`]),
  );
  await assert.rejects(store.save("../oc_1", "om_root", "om_1", "x"), /chat_id 格式不对/);
  await assert.rejects(store.get("oc/1", "om_root", ["om_1"]), /chat_id 格式不对/);
  await assert.rejects(store.save("oc_1", "../om_root", "om_1", "x"), /话题 id 格式不对/);
});

test("文件坏了时挪到 .bad 留着，从空的重新记", async () => {
  const dir = await tempDir();
  const store = new CardAnswerStore(dir);
  await store.save("oc_1", "om_root", "om_1", "回答");
  await writeFile(path.join(dir, "oc_1", "om_broken.json"), "{坏了");

  assert.deepEqual([...(await store.get("oc_1", "om_broken", ["om_1"]))], []);
  await store.save("oc_1", "om_broken", "om_2", "新的");
  const [bad] = (await readdir(path.join(dir, "oc_1"))).filter((name) => /^om_broken\.json\.\d+\.bad$/.test(name));
  assert.equal(await readFile(path.join(dir, "oc_1", bad), "utf8"), "{坏了");
  assert.deepEqual([...(await new CardAnswerStore(dir).get("oc_1", "om_broken", ["om_2"]))], [["om_2", "新的"]]);
});
