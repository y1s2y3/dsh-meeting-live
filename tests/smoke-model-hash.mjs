import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

/* 模型文件校验回归：下载后必须按清单 SHA-256 校验（防 hf-mirror 镜像被替换）。
   本测试覆盖：哈希计算正确性、清单完整性（每个文件都有大小与哈希）、本机已下载模型与清单一致。 */

const root = path.join(process.env.USERPROFILE, 'Desktop', 'dsh-meeting-live-src');
const moduleFile = path.join(root, 'src', 'lib', 'model-manager.js');
const { sha256File, describeAssets } = await import(pathToFileURL(moduleFile).href);

let failures = 0;
function check(name, passed, detail) {
  if (passed) {
    console.log('[OK] ' + name);
  } else {
    failures += 1;
    console.log('[FAIL] ' + name + (detail === undefined ? '' : ' → ' + JSON.stringify(detail)));
  }
}

/* 1. sha256File 结果与标准摘要一致 */
{
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-meeting-hash-'));
  const file = path.join(dir, 'abc.txt');
  await fsp.writeFile(file, 'abc');
  const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  const actual = await sha256File(file);
  check('sha256File 与标准摘要一致', actual === expected, actual);
  // 改一个字节后摘要必须变化
  await fsp.writeFile(file, 'abd');
  const mutated = await sha256File(file);
  check('sha256File 能发现内容变化', mutated !== expected, mutated);
  await fsp.rm(dir, { recursive: true, force: true });
}

/* 2. 清单完整性：每个文件都要有 >0 的大小和 64 位十六进制 sha256 */
{
  const assets = describeAssets();
  const files = [];
  for (const [kind, spec] of Object.entries(assets)) {
    for (const file of spec.files ?? []) files.push({ kind, ...file });
  }
  check('模型清单非空', files.length >= 4, files.length);
  check('每个模型文件都有期望大小', files.every((file) => Number(file.bytes) > 0), files.map((file) => [file.kind, file.name, file.bytes]));
  check('每个模型文件都有 64 位 sha256', files.every((file) => typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/.test(file.sha256)), files.map((file) => [file.name, file.sha256]));
  // 钉死关键哈希：改动清单必须是有意为之（同时防止镜像替换被悄悄放过）
  const pinned = {
    'paraformer/model.int8.onnx': '90bc03034ae1bef9575f8cc798cd1519c8be8aa9e8b458a033e32017ff4d584c',
    'paraformer/tokens.txt': '6c0e3b35cece259829e6cb5b8d90d13db88f61ea3a2953d11898e4b2bfd7a2e2',
    'segmentation/model.int8.onnx': 'd582f4b4c6b48205de7e0643c57df0df5615a3c176189be3fc461e9d18827b5d',
    'campplus/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx': 'f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11'
  };
  for (const file of files) {
    const key = file.kind + '/' + file.name;
    if (pinned[key] !== undefined) check('清单哈希与官方一致：' + key, file.sha256 === pinned[key], file.sha256);
  }
}

/* 3. 本机已下载的模型如果存在，必须与清单哈希一致（没有下载就跳过） */
{
  const assets = describeAssets();
  const modelDir = path.join(process.env.USERPROFILE ?? os.homedir(), '.dsh', 'meeting-minutes-models');
  let checked = 0;
  for (const [kind, spec] of Object.entries(assets)) {
    for (const file of spec.files ?? []) {
      const local = path.join(modelDir, kind, file.name);
      if (!fs.existsSync(local)) continue;
      const actual = await sha256File(local);
      checked += 1;
      check('本机模型与官方哈希一致：' + kind + '/' + file.name, actual === file.sha256, actual);
    }
  }
  console.log('本机已下载模型校验数:', checked, checked === 0 ? '（未下载，跳过）' : '');
}

if (failures > 0) {
  console.log('MODEL HASH CHECKS FAILED:', failures);
  process.exitCode = 1;
} else {
  console.log('ALL MODEL HASH CHECKS PASSED');
}
