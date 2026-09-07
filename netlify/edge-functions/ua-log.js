// Kääselä — AIクローラー UA ログ（ROADMAP_zh.md Phase 0「検証A」対応）
//
// 目的：ChatGPT-User と OAI-SearchBot をはじめとする主要AIクローラー／フェッチャーの
// 実アクセスを記録する。GEO研究の一次データ（誰が・いつ・どのパスを取りに来たか）。
//
// 設計方針（重要）：
// - マッチしたAI関連UAのみを記録する。人間の訪問者は一切記録しない。
//   → 個人データを増やさないための意図的な設計。プライバシーポリシーの対象範囲は
//     newsletterフォームのメールアドレスのみのまま変わらない。
// - ログ失敗（Blobsが使えない等）があってもページ配信は止めない。

// Edge Functionsはesbuildによる静的バンドルのため、bare specifier "@netlify/blobs" は
// 解決できない（2026-08-03 実デプロイで確認：Could not resolve "@netlify/blobs"）。
// Deno互換のesm.sh経由でインポートする。
//
// 2026-09-07：`@8` から `@10` へ更新。8系は現行最新（10.7.x）から2メジャー遅れており、
// Netlify側のBlobsバックエンドが旧クライアントの想定と非互換になった可能性がある
// （8/19以降ログが書かれない件、`_lab/edge-function-ua-log-notes.md` 参照）。
// ただしこれは確定した根因ではない。バージョン更新は「確定した修正」ではなく
// 衛生上の是正として行い、原因の切り分けは下の診断ログで別途行う。
import { getStore } from "https://esm.sh/@netlify/blobs@10";

// 既知のAI関連UAの部分文字列（大小無視）。
// 用途に応じて追加・削除してよい。ChatGPT-User と OAI-SearchBot の区別が本研究の主眼
// （STATUS.md「ChatGPT-User vs OAI-SearchBot」）なので、この2つは絶対に落とさないこと。
const AI_UA_PATTERNS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-Web",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "GoogleOther",
  "CCBot",
  "Bytespider",
  "Amazonbot",
  "cohere-ai",
  "Applebot-Extended",
  "Diffbot",
  "Meta-ExternalAgent",
  "facebookexternalhit",
];

export default async (request, context) => {
  const ua = request.headers.get("user-agent") || "";
  const uaLower = ua.toLowerCase();
  const matched = AI_UA_PATTERNS.find((p) => uaLower.includes(p.toLowerCase()));

  if (matched) {
    const url = new URL(request.url);
    const record = {
      ts: new Date().toISOString(),
      matched,
      ua,
      path: url.pathname,
      referer: request.headers.get("referer") || null,
      country: context.geo?.country?.code || null,
    };

    // すぐ見える速報値：Netlifyダッシュボードの Edge Functions ログタブに出る
    // （保持期間は短いので、恒久記録は下のBlobs書き込みに依存する）
    console.log("[ua-log]", JSON.stringify(record));

    // 恒久記録：Netlify Blobs に日付単位で追記（JSONL形式）
    //
    // 【2026-09-07 追加・診断用】2026-08-19以降、関数は起動しUAマッチもしているのに
    // Blobsにファイルが増えない事象が続いている（8/17の最終デプロイ以降コードは不変、
    // 8/18までは正常に書けていた＝バンドル内容の変化では説明できない）。
    // 原因候補が3つあり、外形観測では区別できないため、段階ごとに痕跡を残す：
    //   (a) write-ok が出るのにファイルが無い → スコープ／バックエンド側の問題
    //   (b) store-ok の後で途切れる → awaitの最中にisolateが停止（タイムアウト等。
    //       この場合 catch は走らず console.error も残らない）
    //   (c) エラー行が出る → 実際の例外内容が取れる
    // 原因が確定したらこの診断ログは削ってよい。
    const day = record.ts.slice(0, 10); // YYYY-MM-DD
    const key = `${day}.jsonl`;
    try {
      const store = getStore({ name: "ua-log", consistency: "strong" });
      console.log("[ua-log] diag store-ok", key);
      const existing = (await store.get(key)) || "";
      console.log("[ua-log] diag read-ok", key, "len=" + existing.length);
      await store.set(key, existing + JSON.stringify(record) + "\n");
      console.log("[ua-log] diag write-ok", key);
    } catch (err) {
      // Blobs書き込み失敗はページ配信をブロックしない。console.logの速報値のみ残る。
      // Errorオブジェクトをそのまま渡すと環境によって {} に潰れるため、
      // name / message を明示的に取り出す。
      console.error(
        "[ua-log] blobs write failed:",
        err?.name,
        err?.message,
        String(err),
      );
    }
  }

  return context.next();
};
