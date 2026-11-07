(function () {
  'use strict';
  var form = document.getElementById('chk-form');
  var input = document.getElementById('chk-domain');
  var button = document.getElementById('chk-go');
  var out = document.getElementById('chk-out');
  if (!form) return;

  function el(tag, attrs) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (k === 'text') n.textContent = attrs[k]; else if (k === 'class') n.className = attrs[k]; else n.setAttribute(k, attrs[k]); }
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c == null) continue; n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
    return n;
  }
  function link(href, text) { return el('a', { href: href, text: text }); }

  var INPUT_ERR = {
    empty: 'ドメインを入力してください。',
    ip: 'IPアドレスではなく、ドメイン（example.com の形）を入力してください。',
    port: 'ポート番号は指定できません。ドメイン（example.com の形）だけを入力してください。',
    userinfo: 'ドメイン（example.com の形）だけを入力してください。',
    invalid: 'ドメインの形が正しくないようです。例：example.com',
    tld: 'ドメインの形が正しくないようです。例：example.com'
  };

  function why(code) {
    var m = { dns: 'ドメインが見つかりません', timeout: 'タイムアウト', tls: 'HTTPS の証明書を確認できません', connection: '接続できません', blocked: '公開サーバーに接続していないドメインです', 'redirect-limit': 'リダイレクトが5回を超えました', budget: '確認の回数上限に達しました', 'http-401': '401', 'http-403': '403', 'http-429': '429', 'http-5xx': 'サーバーエラー', 'robots-invalid': 'robots.txt の形ではない応答が返りました' };
    return m[code] || code;
  }
  function pageUnknown(code) {
    if (code === 'robots-disallow-checker') return 'robots.txt が KaaselaChecker の取得を禁止しているため、トップページは取得していません。';
    if (code === 'robots-unavailable') return 'robots.txt を確認できなかったため、トップページは取得していません。';
    if (code === 'home-unavailable') return 'トップページを取得できなかったため、確認していません。';
    if (code === 'not-html') return 'トップページがHTMLではなかったため、確認していません。';
    if (code === 'dns') return 'ドメインが見つかりませんでした。入力したドメインの綴りを確認してください。';
    if (code === 'blocked') return 'このドメインは公開サーバーに接続していないため、確認できません。';
    if (/^http-(401|403|429)$/.test(code)) return why(code) + ' でした。サイト側の防御設定が、この取得プログラムだけを拒否した可能性があります。AIクローラーへの応答を表すものではないので、未通過にはしていません。';
    return why(code) + 'でした。サイトが一時的に応答しなかった可能性があります。AIクローラーへの応答を表すものではないので、未通過にはしていません。';
  }

  function row(item, title, texts) {
    var st = item.status;
    var label = st === 'pass' ? '● 通過' : st === 'fail' ? '未通過' : '○ 確認できず';
    return el('div', { 'class': 'chk-row' },
      el('div', { 'class': 'chk-st is-' + st, text: label }),
      el('div', null, el('h3', { text: title }), el('p', { text: texts[st] })));
  }

  function verdictLine(r) {
    var s = { pass: '通過', fail: '未通過', unknown: '確認できず' };
    return [
      ['OAI-SearchBot が robots.txt で禁止されていない', r.items.robots],
      ['トップページに到達できる', r.items.reach],
      ['インデックス拒否（noindex）がない', r.items.noindex],
      ['本文が最初のHTMLにある', r.items.body]
    ].map(function (x) { return '- ' + x[0] + '：' + s[x[1].status]; }).join('\n');
  }

  function render(r) {
    var it = r.items, ref = r.reference || {};
    var when = new Date(r.checkedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    var rows = [];
    rows.push(row(it.robots, 'OAI-SearchBot が robots.txt で禁止されていない', {
      pass: it.robots.state === 'absent' ? 'robots.txt は見つかりませんでした。禁止の記述はありません。' : 'robots.txt は OAI-SearchBot（ChatGPT 検索のクローラー）を禁止していません。',
      fail: 'robots.txt が OAI-SearchBot を禁止しています。OpenAI の公式文書では、OAI-SearchBot を拒否したサイトは ChatGPT 検索の回答に表示されないと説明されています。変更が反映されるまでには約24時間かかる場合があります。意図した設定かどうか、確認してください。',
      unknown: 'robots.txt を取得できませんでした（理由：' + why(it.robots.reason) + '）。通過とも未通過とも数えません。'
    }));
    rows.push(row(it.reach, 'トップページに到達できる', {
      pass: 'トップページは 200 で返り、リダイレクトは ' + it.reach.redirects + ' 回でした。',
      fail: 'トップページは 200 で返りませんでした（HTTP ' + it.reach.httpStatus + '）。',
      unknown: pageUnknown(it.reach.reason)
    }));
    rows.push(row(it.noindex, 'インデックス拒否（noindex）がない', {
      pass: 'トップページのHTMLとHTTPレスポンスに、noindex の指定は見つかりませんでした。',
      fail: 'トップページに noindex の指定があります（' + (it.noindex.via || []).map(function (v) { return v === 'meta' ? 'meta の robots' : 'X-Robots-Tag'; }).join('・') + '）。',
      unknown: pageUnknown(it.noindex.reason)
    }));
    rows.push(row(it.body, '本文が最初のHTMLにある', {
      pass: 'JavaScript を実行しない状態で、本文の文字数は ' + it.body.chars + ' 字、見出しは' + (it.body.hasHeading ? 'あり' : 'なし') + 'でした。',
      fail: 'JavaScript を実行しない状態では、本文がほとんど見えません（' + it.body.chars + ' 字。' + it.body.threshold + '字未満を未通過としています）。ブラウザでは正常に表示されていても、最初に取得される HTML には本文が含まれていない可能性があります。AIクローラーは JavaScript を実行しないとする報告が複数ありますが、OpenAI の公式文書には記載がありません。',
      unknown: pageUnknown(it.body.reason)
    }));

    var skipped = !!(ref.skipped || (ref.page && ref.page.skipped));
    function pageRef(f) { return skipped || !ref.jsonld ? '確認していません' : f(); }
    var refParts = [
      ['構造化データ（JSON-LD）：', pageRef(function () { return ref.jsonld.present ? 'あり：' + ref.jsonld.types.join('／') : 'なし'; })],
      ['sitemap.xml：', !ref.sitemap ? '確認していません' : ref.sitemap.status === 'found' ? (ref.sitemap.source === 'robots' ? 'あり（robots.txt で宣言）' : 'あり（/sitemap.xml）') : ref.sitemap.status === 'none' ? 'なし' : ref.sitemap.status === 'skipped' ? '確認していません' : '確認できず'],
      ['言語：', pageRef(function () { return 'html lang=' + (ref.lang.htmlLang || 'なし') + '、hreflang=' + (ref.lang.hreflang ? 'あり' : 'なし') + '、他言語ページ=' + (ref.lang.otherLangs ? '確認できた' : '確認できず'); })],
      ['title・description：', pageRef(function () { return ref.titleDesc.title && ref.titleDesc.description ? 'あり' : (ref.titleDesc.title ? '' : 'タイトルなし ') + (ref.titleDesc.description ? '' : '説明文なし'); })],
      ['llms.txt：', !ref.llms ? '確認していません' : ref.llms.status === 'found' ? 'あり' : ref.llms.status === 'none' ? 'なし' : ref.llms.status === 'skipped' ? '確認していません' : '確認できず']
    ];
    var refP = el('p', { 'class': 'chk-refs' });
    refParts.forEach(function (p, i) { if (i) refP.appendChild(document.createTextNode(' ／ ')); refP.appendChild(el('span', { text: p[0] + p[1] })); });

    var subject = 'AI検索のアクセス条件チェック：' + r.domain;
    var body = 'チェックしたドメイン：' + r.domain + '\n確認日時：' + when + '\n結果：\n' + verdictLine(r) + '\n\n（ご質問・ご意見を、この下にお書きください）\n';
    var mailto = 'mailto:kamogawa.ai.lab@gmail.com?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);

    function ctx(head, text, links) {
      var li = el('li', null, el('strong', { text: head }), text);
      var src = el('span', { 'class': 'src' }, '→ ');
      links.forEach(function (l, i) { if (i) src.appendChild(document.createTextNode('／')); src.appendChild(link(l[0], l[1])); });
      li.appendChild(src);
      return li;
    }

    var wrap = el('div', { 'class': 'chk-result' },
      el('h2', { text: r.domain + ' の確認結果' }),
      el('p', { 'class': 'chk-when', text: when + ' に1回取得。Kääselä の取得プログラムによる結果で、OpenAI など各社のクローラーの実際のアクセスを保証するものではありません。' }),
      el('h2', { text: '1. 到達できるか' }));
    rows.forEach(function (x) { wrap.appendChild(x); });
    wrap.appendChild(el('p', { 'class': 'chk-foot', text: '文字数は script・style・noscript を除いた可視テキストで数えます。' }));
    wrap.appendChild(el('h2', { text: '2. 参考（以下の有無と、AI の回答への影響は、現時点で確認できていません）' }));
    wrap.appendChild(refP);
    wrap.appendChild(el('h2', { text: '3. 検査では見えないが、あわせて確認したいこと' }));
    wrap.appendChild(el('p', { text: 'このチェックが見るのは「遮られていないか」までです。次の4つは機械では判定できませんが、Kääselä の観測では AI の回答に関わっていました。' }));
    var ul = el('ul', { 'class': 'chk-ctx' });
    ul.appendChild(ctx('料金・対応内容・所在地・予約方法など、店の基本情報が公式サイトに書かれているか。', '1回の回答に自社サイトの引用が1件以上ある割合は、第2号が52%、第3号が90%でした（モデルと取得方法が同時に変わっています）。', [['/reports/small-business-ai-visibility/', 'Feature「個人店・小さな会社が、AIにどう見つけてもらうか」'], ['/reports/2026-11/#findings', '第3号 §3.3']]));
    ul.appendChild(ctx('予約サイトや紹介ページの一項目として、埋もれていないか。', '予備調査（京都の体験店10店）では、公式情報が予約プラットフォームの紹介ページに埋もれた店を、AI が別の店と混同した例がありました。', [['/reports/kyoto-experience-2026/', 'Feature「Googleでは★4.9。それでもAIは、その店を見つけられなかった。」']]));
    ul.appendChild(ctx('地図に出る登録情報と、サイトの内容が食い違っていないか。', '第3号では、本文の推薦と地図カードの店が食い違った回が240回中56回（23.3%）ありました。2店の確認では、AI の地図カードに表示された Web 情報が、Bing Places（Microsoft の事業者登録サービス）に登録された事業者情報と一致していました。', [['/reports/2026-11/#mapcards', '第3号 §5'], ['/reports/2026-08/#revisions', '第0号 改訂記録']]));
    ul.appendChild(ctx('比較サイトや予約サイトに載っているか。', '業種によって、AI が引用する情報源の中心は異なります。着物レンタルは4言語とも比較メディア主導、座禅は自社・公共機関の発信が中心でした（第0号）。', [['/reports/2026-11/#findings', '第3号 §3'], ['/reports/small-business-ai-visibility/', 'Feature「個人店・小さな会社が、AIにどう見つけてもらうか」']]));
    wrap.appendChild(ul);
    wrap.appendChild(el('h2', { text: '4. 通過しても、引用されるとは限りません' }));
    wrap.appendChild(el('p', { text: 'このチェックが測るのは「技術的に遮られていないか」までです。通過しても、AI の回答に出ることは約束されません。どの情報が選ばれるかは、技術的な条件だけで決まるとは限りません。' }));
    wrap.appendChild(el('h2', { text: '5. 質問・意見' }));
    wrap.appendChild(el('p', { text: 'このチェックの方法や結果について、質問や意見があればメールでどうぞ。' }));
    wrap.appendChild(el('p', null, el('a', { 'class': 'chk-cta', href: mailto, text: '質問・意見をメールで送る' })));
    wrap.appendChild(el('p', { 'class': 'chk-note', text: '個別の診断・有償のご依頼は受けていません。' }));
    return wrap;
  }

  function show(node) { out.textContent = ''; out.appendChild(node); out.focus({ preventScroll: false }); }
  function showError(msg) { show(el('p', { 'class': 'chk-error', text: msg })); }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var domain = input.value.trim();
    if (!domain) { showError(INPUT_ERR.empty); return; }
    button.disabled = true;
    show(el('p', { 'class': 'chk-busy', text: '確認しています。数秒かかります。' }));
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, 20000);
    fetch('/api/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ domain: domain }), signal: ctl.signal, cache: 'no-store' })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (j) { return { res: res, j: j }; }); })
      .then(function (x) {
        if (x.res.status === 400 && x.j.error === 'invalid-input') return showError(INPUT_ERR[x.j.reason] || INPUT_ERR.invalid);
        if (x.res.status === 429) return showError('短い時間に確認が集中しています。しばらくしてから、もう一度お試しください。');
        if (!x.res.ok || !x.j.items) return showError('確認を実行できませんでした。時間をおいて、もう一度お試しください。');
        show(render(x.j));
      })
      .catch(function () { showError('確認を実行できませんでした。時間をおいて、もう一度お試しください。'); })
      .then(function () { clearTimeout(t); button.disabled = false; });
  });
})();
