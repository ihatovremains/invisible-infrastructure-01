# Invisible Infrastructure · Ep. 01

**"A customer is ready to sign — but asks for net-60. Can AI answer safely?"**

企業環境でユーザーの質問がどう処理されていくか(認証 → ガードレール → RAG → API呼び出し → 人の承認 → 監査ログ → 応答)を、**1つのrequest packetが権限・根拠・承認を獲得しながら移動していく**約49秒の自動再生モーションで可視化する単一ページのプロトタイプ。LinkedIn投稿用の画面収録を想定。

## 仕組み(v2)

- 9枚のフル画面パネルを横一列に並べ、**カメラ(worldのtranslateX)が左→右へパン**して移動する
- 画面に固定された **request packet カード**が全シーンを通して存在し続け、各ステーションで状態チップが押されていく(Identity verified → Data scopes granted → Needs human approval(amber)→ 3 sources attached → Payment record: clean → Finance approved → trace ID)
- **Needs human approvalのアンバーチップは、承認時に 3 sources attached と Payment record の下へ移動し、その後 Finance approved としてグリーンへ変化する**(判断根拠の下に承認が並ぶ)。シーン間を直接ジャンプした場合も `buildPacket()` が同じ順序で再構築する
- packetの状態はシーン番号から決定論的に再構築されるため、`←` `→` でどこへ飛んでも破綻しない
- 人物は3か所だけ: 冒頭(顧客とSales Ops担当者)、Approval(Finance Controller)、Response(冒頭の担当者に回答が戻る)。ミニマルな線画SVG
- メインコピーはビジネス語彙、技術情報(Okta/MFA/embedding/APIパス/trace)は各カード下部の小さなmono脚注

## 実行

外部依存ゼロの単一 `index.html`。ブラウザで開くだけで自動再生。

```bash
open index.html
# または
python3 -m http.server 8000   # http://localhost:8000
```

## 操作

| キー / ボタン | 動作 |
|---|---|
| `Space` | 一時停止 / 再開 |
| `←` `→` | 前 / 次のシーンへ(停止中は完成状態の静止画になる) |
| `R` | 最初からリプレイ |
| `F` | 現在シーンの演出を一括完了(静止画キャプチャ用) |
| `S` | **social mode** 切替(下記) |
| マウス静止 2.6秒 | コントロールとヒントが自動フェード |

## Social mode(1080×1350 · 4:5 縦型録画)

`<body>` に `.social-mode` を付けると4:5録画向けに最適化されます。切替方法は3つ: `S`キー / URLに `?social` / コンソールで `journey.social(true)`。

- 見出し・キャプション・カード本文を約25%拡大、packetを312pxに拡大
- 技術脚注(mono)非表示、監査ログはビジネスサマリー表示に切替
- Replayボタン非表示、代わりに "Interactive demo + source in comments" を表示
- 16:9のライブHTML表示とキーボード操作はそのまま維持

コンソール: `journey.goto(n)` / `journey.pause()` / `journey.replay()` など。

## 収録のコツ

1. ブラウザを全画面(1920×1080以上、できれば4K)にし、マウスを画面外へ
2. `R` でタイトルからクリーン再生(全体 約49秒)
3. 特定シーンの録り直しは `←` `→` で頭出し
4. タブが非表示だと再生が止まる(ブラウザ標準挙動)。収録中は常に前面に
5. `prefers-reduced-motion` は収録マシンでは無効にしておく

## タイムライン(約49秒)

| # | 時間 | シーン | 見せ場 | Packetへの追加 |
|---|---|---|---|---|
| 0 | 0:00–0:05 | Opening | 人物+問題提起→質問タイプ→Send push-in | packet誕生 |
| 1 | 0:05–0:10 | Identity | 平易な本人確認+mono脚注 | Identity verified / Data scopes granted |
| 2 | 0:10–0:16 | Guardrails | 金融条件に「人のサインオフ」フラグ | Needs human approval (amber) |
| 3 | 0:16–0:20 | Retrieval | 文書カードがpacketに吸収→0.6秒で次へ | 3 sources attached |
| 4 | 0:20–0:26 | Verification | known/missing→財務システム照会 | Payment record: clean · rating A |
| 5 | 0:26–0:33 | Approval | 3項目を0.7秒間隔で確認→承認。amberチップが根拠の下へ移動してからgreen化 | Finance approved |
| 6 | 0:33–0:38 | Audit | 監査ログ書き込み(social時はビジネスサマリー) | trace 7f3a-90d1-c21e |
| 7 | 0:38–0:45 | Response | packet納品→2段構成の回答、完成状態を約2.8秒保持 | (納品・消滅) |
| 8 | 0:45– | Closing | 統計→"It's a system." + 制作クレジット | — |

数値は全シーンで整合(機械1.7s / 人間11.8s / 7チェックポイント / 3出典)。

## GitHub Pages 公開

```bash
cd invisible-ai-journey
git init && git add . && git commit -m "Ep. 01 — After you press Send"
gh repo create invisible-infrastructure-01 --public --source=. --push
gh api repos/{owner}/invisible-infrastructure-01/pages -X POST \
  -f 'source[branch]=main' -f 'source[path]=/'
# → https://<owner>.github.io/invisible-infrastructure-01/
```

## 登場する名前・数値について

人物・会社・数値(レイテンシ、trace ID、ref番号)はすべて架空です。実在の顧客名・案件情報は含まれていません。作中人物は "Tak Suzuki"(架空)、制作クレジットは "Taka Suzuki"。
