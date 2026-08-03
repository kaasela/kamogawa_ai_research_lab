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

import { getStore } from "@netlify/blobs";

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
    try {
      const store = getStore({ name: "ua-log", consistency: "strong" });
      const day = record.ts.slice(0, 10); // YYYY-MM-DD
      const key = `${day}.jsonl`;
      const existing = (await store.get(key)) || "";
      await store.set(key, existing + JSON.stringify(record) + "\n");
    } catch (err) {
      // Blobs書き込み失敗はページ配信をブロックしない。console.logの速報値のみ残る。
      console.error("[ua-log] blobs write failed:", err);
    }
  }

  return context.next();
};
