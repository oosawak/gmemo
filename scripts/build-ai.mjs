import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('index.html', root), 'utf8');
// Share behavior, not the human-facing layout. Both outputs remain standalone HTML.
const scripts = source.slice(source.indexOf('  <script>'), source.indexOf('</body>'));
const dialogs = [...source.matchAll(/  <dialog\b[\s\S]*?<\/dialog>/g)].map(match => match[0]).join('\n');
const ui = `
<p><b>GMEMO AI</b> · <a href="GMEMO.MD" download>GMEMO.MD</a> · <a href="index.html">人向け画面</a></p>
<details><summary>AIに依頼する前の準備</summary><ol><li>先にこのAI用画面を開き、初回は「初期設定」でAI用クライアントIDを登録します。</li><li>「Googleに接続」で接続を済ませ、アカウントが表示されることを確認します。</li><li>このタブを開いたまま、AIにGMEMO.MDと対象ファイルのURLを渡してください。再読み込みは不要です。</li></ol></details>
<p><span id="identity">未接続</span>
<button id="login">Googleに接続</button><button id="reconnect" hidden>再接続</button><button id="logout" hidden>接続解除</button><button id="settings">初期設定</button></p>
<p><label for="ai-key">KEY（ファイルURL / ID）</label><br>
<input id="ai-key" size="65" autocomplete="off">
<button id="ai-get" data-remote>取得</button><button id="ai-download" disabled>ファイルをダウンロード</button></p>
<p><label for="ai-result">結果JSON</label><br>
<textarea id="ai-result" rows="3" cols="90" readonly spellcheck="false"></textarea></p>
<hr>
<p><label for="ai-folder">新規保存先（フォルダURL / ID）</label><br>
<input id="ai-folder" size="65" placeholder="空欄 = 初期フォルダー" autocomplete="off"><button id="ai-set-folder" data-remote>保存先を設定</button><br>
保存先：<span id="destination">未指定</span></p>
<p><button id="new-note">＋ 新規</button> <span id="editor-label">新しいメモ</span></p>
<p><label for="title">メモのタイトル</label><br><input id="title" size="65" maxlength="180"></p>
<p><label for="body">Markdown本文</label><br><textarea id="body" rows="8" cols="90" spellcheck="false"></textarea></p>
<p><button id="choose-files">＋ ファイルを添付</button><input id="file-input" type="file" multiple hidden></p>
<div id="queue" aria-live="polite"></div>
<p><button id="save" disabled>Driveに保存</button> <button id="ai-replace" disabled>元ファイルを更新</button></p>
<p id="status" role="status" aria-live="polite">KEYを指定して取得。新規保存時は保存先を指定。</p>`;
// Keep inert targets for shared human-only event bindings. No human UI is copied.
const present = new Set([...`${ui}${dialogs}`.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
const unused = [...source.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]).filter(id => !present.has(id));
const slots = [...new Set(unused)].map(id => `<span id="${id}" hidden></span>`).join('');
const html = `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GMEMO AI</title></head>
<body data-mode="ai">
${ui}
${dialogs}
<div hidden aria-hidden="true">${slots}</div>
${scripts}</body>
</html>
`;
const target = new URL('ai.html', root);
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== html) { console.error('ai.html is out of date. Run node scripts/build-ai.mjs'); process.exitCode = 1; }
  else console.log('ai.html is up to date');
} else { writeFileSync(target, html); console.log(`Generated ${fileURLToPath(target)}`); }
