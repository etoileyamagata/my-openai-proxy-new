# AILIS eBay 共通サーバーの導入

2026-09-12。共有フォルダのHTMLを各PCで開き、eBay出品を共通サーバーへ引き継ぐ構成です。ユーザーの「追加料金なし」という条件に合わせ、出品画面はNetlify Free、共通DBはNeon Freeを利用する構成へ変更しました。担当者PCでPython・Node.js・ローカルサーバーを起動する必要はありません。

## 現在の状態

2026-09-12 14:10、GitHubの `codex/ebay-trading-shared-browser` にコミット `7c7086bf5188119ba41289fe38fd9352fc3bda54` を反映しました。Netlify Freeの最新デプロイは `6aa4deceb0ead40008165472`。URLは `https://ailis-ebay.netlify.app/ebay/`、プロジェクトIDは `e5969f9a-6fbe-4ce9-ad7a-523b62ceb4c7` です。Publishedを確認し、配信部品の不足による接続エラーが解消して「担当者ログイン」が表示されることを実画面で確認しました。引き続きPrivateで、一般公開していません。

Neon Free「ailis-ebay」の初期設定は完了しています。接続設定・作業中の商品・二重出品防止に必要な8テーブルと設定2行をQuery画面で確認し、読み取り専用へ戻しました。Neon Authは無効、VercelへのDB接続はスキップしています。利用者の許可を得て、Neonのプール対応接続情報をNetlifyの `DATABASE_URL` に、秘密の値としてProductionだけに保存しました。TLSは `sslmode=verify-full`。`AILIS_EBAY_ORIGIN=https://ailis-ebay.netlify.app` も設定済みです。接続文字列とパスワードはソース・共有フォルダ・この文書へ記録していません。

NetlifyはFree・カード未登録で進めています。GitHub Appは許可を得て `etoileyamagata/my-openai-proxy-new` 1件だけに接続しました。mainと既存Vercel APIは変更していません。

次に管理者が `AILIS/eBay_管理者初期設定.html` をChrome/Edgeで開き、担当者ログイン名・12文字以上のパスワードを決めて「設定値を作成」を押します。新しいパスワードの入力・作成は本人が行います。CodexブラウザのURL規則がfile://への自動表示を拒否したため、手動で開く必要があります。パスワード・生成したキーをチャットへ貼り付けないよう案内しています。

未完了は、担当者ログイン名・パスワードハッシュ・セッションキー・暗号化キーの登録、NetlifyからDBへの実接続確認、eBay開発者キー・OAuth接続、Sandboxの実検査です。実eBay接続・画像送信・実出品はしていません。AILISのportalUrlは準備完了まで空欄です。

振り返り用の履歴一覧を省き、「作業中の商品」に成功確認済みの商品を表示しない変更を反映しました。二重出品防止・直後の結果確認・Sandboxから本番への引継ぎに使うデータは内部に残します。APIの34検証、2つの独立したブラウザでの操作、公式梱包ツールで作った配信物の隔離起動・XML検査まで模擬応答で確認済みです。

## 無料で運用する条件

- 当初候補のVercel Hobbyは個人の非商用利用に限定されています。今回の店舗出品業務をこのプランに追加する案は取り下げました。既存Vercel APIの運用条件確認・移設は、この出品APIの設置とは別途必要です。[Vercel公式条件](https://vercel.com/docs/plans/hobby)
- Netlify Freeは商用利用可能です。2026-09-12確認時、月額0ドル・月300 creditsの上限があり、自動追加購入はありません。無料枠を使い切ると停止するため、無制限の可用性を約束する構成ではありません。有料プラン・有料追加機能・独自ドメイン購入は選びません。[商用利用の案内](https://www.netlify.com/blog/introducing-netlify-free-plan/)・[現在の料金条件](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/)
- Neonは作成画面のFreeプラン（カード不要、0.5 GB、100 CU-hours/プロジェクト）を選択しました。更新・有料プランへの切替は行いません。利用上限に達した場合は、課金への切替をせず停止原因を確認します。作成後の使用量はNeon管理画面で確認してください。
- 通常のeBay出品・販売手数料と、既存AILISのOpenAI等の利用料は、今回追加するサーバーの無料枠とは別です。

## 管理者が一度行う設定

1. 作成済みのNeon Free「ailis-ebay」を開き、`db/ebay.sql` をSQL画面で実行します。接続文字列はTLSとサーバー証明書検証を有効にし、接続プール対応URLを使います。DBを重複作成する必要はありません。
2. AILISフォルダの `eBay_管理者初期設定.html` をChromeまたはEdgeで開き、担当者用ログイン名・パスワードを決めます。ブラウザ内でハッシュと暗号化キーを生成します。この操作も追加ソフト不要です。
3. Netlify Freeに登録し、出品用のプロジェクトを作成します。登録規約・GitHub等へのアクセス許可は内容を確認して同意します。NetlifyのEnvironment variablesへ下表を設定し、値の対象はProductionに限定します。Freeではスコープの個別制限はできないため標準のAll scopesを使い、ビルド処理は設定値を出力・埋め込みしません。Functionsへのスコープ限定のために有料プランへ変更しないでください。共有フォルダのJSやGitHubに秘密情報を置きません。[環境変数の設定条件](https://docs.netlify.com/build/environment-variables/overview/)
4. SandboxのeBay開発者キーを用意し、OAuth用RuNameの認証成功URL・拒否時URLを `https://発行されたホスト名/api/ebay-trading?action=callback` に設定します。RuName欄に入力するのはURLではなく、eBayが発行したRuNameです。
5. コードをレビューしてNetlifyへ反映します。`netlify.toml` はNode.js 24、ビルド `npm ci --omit=dev --no-audit --no-fund && node scripts/build-ebay.cjs`、公開フォルダ `dist-ebay`、関数フォルダ `netlify/functions` を指定済みです。リポジトリルートを公開フォルダに設定しないでください。`/api/ebay-trading` は関数のconfig.pathで配信されます。同期処理は60秒上限のため、eBay通信全体を40秒で打ち切り、結果保存用の余裕を残します。[Netlify関数の設定・制限](https://docs.netlify.com/build/functions/configuration/)
6. `/ebay/` で担当者ログインできることを確認します。「接続設定」でSandboxを選び、eBayの画面でテスト出品者として認証します。接続は環境ごとに1アカウントで、全PC・全店舗が共有します。店舗別アカウントの同時利用には対応していません。
7. 商品所在地と配送・返品・支払ポリシーを設定します。Sandboxで画像URL→事前検査→テスト出品→Item ID確認まで行います。本番用キーはSandbox確認後に設定し、本番Media APIの画像送信も確認します。
8. 公開後、共有AILISの `yrtools_minami/AILIS/core/ebayConnection.js` の `portalUrl` に設置済みのHTTPS URLを設定します。店舗別ファイルを生成して配布している場合は、生成先にも同じ設定を反映します。各PCではAILIS画面を再読込します。

| 環境変数 | 設定する値 |
|---|---|
| `AILIS_EBAY_ORIGIN` | 発行された出品画面のHTTPSオリジン。例：`https://YOUR-SITE.netlify.app`。末尾スラッシュ・パスなし |
| `DATABASE_URL` | 共通PostgreSQLの接続文字列。プロバイダのTLS設定に従い、例として `sslmode=verify-full` を使用 |
| `AILIS_LOGIN_USER` | 初期設定HTMLで決めた担当者用の共通ログイン名 |
| `AILIS_LOGIN_PASSWORD_HASH` | 初期設定HTMLが作成したパスワードハッシュ |
| `AILIS_SESSION_SECRET` | 初期設定HTMLが作成した32バイトのBase64キー |
| `AILIS_EBAY_ENCRYPTION_KEY` | 初期設定HTMLが作成した別の32バイトのBase64キー。導入後も保管する |
| `EBAY_SANDBOX_CLIENT_ID` / `EBAY_SANDBOX_CLIENT_SECRET` / `EBAY_SANDBOX_RUNAME` | eBayのSandbox用App ID・Cert ID・OAuth RuName |
| `EBAY_PRODUCTION_CLIENT_ID` / `EBAY_PRODUCTION_CLIENT_SECRET` / `EBAY_PRODUCTION_RUNAME` | 本番用の同3項目。未設定でもSandboxから導入可能 |

eBayへの接続には認可コードフローを使い、更新トークンをサーバーで暗号化保存します。Trading用の基本scope、ポリシー読取用 `sell.account.readonly` を要求し、本番のみ画像用 `sell.inventory` を追加します。[eBay公式の認証手順](https://developer.ebay.com/develop/guides/sell/authorization)

Deploy Previewを使う場合は、固定したPreviewオリジン、専用DB、Sandboxキーだけを設定してください。本番DB・本番キーをPreviewへ引き継がない構成で試します。環境変数を変更したら再デプロイしてください。出品用のブランチをNetlifyのProductionブランチに指定します。このブランチのVercel自動デプロイは `vercel.json` の `git.deploymentEnabled` で停止しています。既存mainへmergeするとVercel側に反映されるため、設置先の運用方針を決めるまではmergeしません。[Vercel Git設定](https://vercel.com/docs/project-configuration/git-configuration)

## 担当者の操作

共有フォルダからAILISを開く → 通常のGATE・属性確認 →「画像・API出品へ進む」→ 共通画面へログイン → 画像と出品条件を確認 → 事前検査 → 最終確認して公開。

商品JSONはURLフラグメントから受け取り、直ちにURLから除去します。ログイン待ち・eBay認証中はそのタブのsessionStorageで引継ぎを保持します。出品準備作成後は共通DBに保存し、別PCから「作業中の商品」で開けます。各PCにeBayのキーを入力する操作はありません。担当者ログインは8時間で期限切れとなり、ログアウト時はサーバーのセッションを削除します。

## 出品・画像・作業の共有

- 対応はAILISの既存時計・バッグ・財布・ジュエリーの米国固定価格・GTC・数量1。TARGETを出品価格、QUICKをBest Offer自動拒否価格にし、自動承諾は設定しません。
- VerifyAddFixedPriceItemで検査後、AddFixedPriceItemで公開します。検査有効期間は15分。画像・商品・共通設定の変更時は再検査します。最終確認と明示的な出品操作が必須です。
- 本番画像はMedia APIのcreateImageFromFileで登録します。JPEG・PNG・GIF、1枚12MiB、最大24枚。1MiBずつ分割して共通DBへ一時保存し、eBay送信後に削除します。中断分は30分で使用不能となり、次回アップロード開始時に削除します。開始回数は全PC合計240回/時までです。Sandboxの画像は公開HTTPS URLを使用します。
- 1MiB単位の分割により、Netlifyの関数入力上限とAPI自身の1,500,000バイト制限内に収めます。元画像を縮小・再圧縮しません。
- 環境・出品者・SKUを一意キーにして、送信記録をDBへ確定してから出品します。複数PC・複数サーバー実行間でも同じ商品の二重送信を防ぎます。別PCの古い画面からの上書きは拒否します。
- タイムアウト・サーバー停止・応答不明は自動再送しません。作業中の商品の「出品結果を照会」でSKUとUUIDを照合します。確定できない場合は停止を維持します。明確な入力エラーだけ、修正・再検査後に再試行できます。
- 共通DBは認証情報、出品準備、画像URL、送信記録を保持します。DBと暗号化キーは両方バックアップしてください。出品後に古いDBへ戻すと送信済み記録を失うため、Seller Hubの実出品と照合してから運用を再開します。
- MC999等によるアカウント制限の解除はeBay側での対応が必要です。APIへの変更自体で制限が解除されるとは扱いません。

## 開発時の検証

以下は開発者向けで、担当者PCで行う作業ではありません。

```
npm ci
npm test
npm run test:browser
```

ブラウザテストにはPlaywrightとEdge（Windows）またはChromiumを使用します。別の場所にPlaywrightがある場合は `AILIS_PLAYWRIGHT_MODULE` を指定できます。テストDBはPGliteの一時メモリ上に作成し、本番と同じPostgreSQLのSQLを実行します。実eBay通信は全て模擬応答です。ブラウザテストは2つの独立したブラウザプロファイルを使い、AILISが隣のフォルダにあれば実際のJSON生成・file://引継ぎも検証します。

Netlify用のHTTP変換、Cookie、CSRF、転送ヘッダー偽装によるログイン回数制限回避、画像チャンク、認証更新で通信期限を消費した場合の重複防止も模擬検証しています。実Netlify上の配信・PostgreSQL接続・OAuthコールバック・Sandboxテスト出品・本番Mediaアップロードは、環境設定後の確認事項です。

## 出品履歴を使わない方針

振り返り用の履歴一覧は設けません。「作業中の商品」は未完了・結果確認中だけを表示し、出品成功が確認された商品を除外します。二重出品防止と送信直後の結果確認、Sandboxから本番への商品引継ぎに使う保存済みデータは内部に残します。Neonはこの送信管理に加え、全PCの接続設定・作業中の商品を共有するために使います。

2026-09-12 13:59、コミット `ecb459f039df133c0340715ff2e5d09d2b1d649b` を同ブランチへ反映し、Netlifyデプロイ `6aa4dc15462970000866aacb` のPublishedを確認しました。プロジェクトは引き続きPrivateです。担当者ログインの設定は、管理者自身がローカルの `eBay_管理者初期設定.html` をChrome/Edgeで開き、ログイン名・パスワードを入力するところから再開します。Codex内ブラウザのURL規則でfile://ページの自動表示は拒否されるため、手動で開きます。

実配信後の関数ログで `Cannot find module 'fast-xml-parser'` が判明しました。NetlifyのV2関数はNFTで処理され、ローカルCommonJSから変換された `__require` 呼び出しの依存部品が追跡から漏れていました。`external_node_modules` の指定だけでは解決しないことを実配信・公式の梱包ツール15.5.1で再現しました。

最終設定は `npm ci --omit=dev --no-audit --no-fund && node scripts/build-ebay.cjs` で本番依存部品だけを揃え、`included_files = ["node_modules/**"]` で関数へ同梱します。画面の公開対象は引き続き3つの静的ファイルだけです。ビルドスクリプトは部品を実際に読み込み、不足した状態を配信しません。[Netlify公式の同梱設定](https://docs.netlify.com/build/configure-builds/file-based-configuration/)

新しい本番依存部品だけのディレクトリを作り、公式の梱包ツールで配信物を生成し、リポジトリから隔離した場所で起動しました。`tests/ebay-bundle.cjs <展開した関数のディレクトリ>` で、pg・XML部品が配信物内から読み込まれること、担当者ログインとCookie、模擬eBayのXML事前検査まで確認しています。実eBay通信はありません。

## 担当者ログイン登録の引継ぎ（2026-09-12）

管理者から「設定値を作成しました」と報告あり。設定値は受領・読取していません。NetlifyのEnvironment variablesで「Import from a .env file」を開き、次の4行だけを入力して本人へ引き継ぎました。まだImport variablesは押していません。

```text
AILIS_LOGIN_USER=
AILIS_LOGIN_PASSWORD_HASH=
AILIS_SESSION_SECRET=
AILIS_EBAY_ENCRYPTION_KEY=
```

Contains secret valuesはチェック済み、Deploy contextsはProductionのみです。管理者が初期設定画面の各「コピー」で値をコピーし、同名行の等号直後に貼り付けてImport variablesを押します。パスワードそのものは貼り付けません。初期設定画面は引き続き閉じないよう案内します。ブラウザ操作規則の新規認証情報入力・保存の本人操作要件に従って引き継いでいます。後続では入力中の秘密を画面出力せず、4項目の登録名と対象環境を確認し、再デプロイ、本人の担当者ログイン、DB実接続確認へ進みます。

## 担当者ログイン設定の保存確認（2026-09-12）

利用者から保存完了の報告を受け、Netlify UIで4項目の存在とProductionの非空マスク表示、他の環境がEmptyであることを確認しました。実際の値は読み出していません。再デプロイ `6aa4e8799e2cb96720a0a982` はログイン名を秘密扱いしたことによるスキャンの誤検知で停止しました。ログには `AILIS_LOGIN_USER` だけが既存のAILIS文字列と一致したと記録されています。

`netlify.toml` へ `SECRETS_SCAN_OMIT_KEYS = "AILIS_LOGIN_USER"` を加え、非機密の識別子だけを対象外とします。秘密のハッシュ・セッションキー・暗号化キー・DB接続情報のスキャンは継続します。変数の登録値・認証方式は変更しません。[Netlify公式のキー単位の除外設定](https://docs.netlify.com/build/environment-variables/secrets-controller/)

反映が成功したら、利用者自身が `https://ailis-ebay.netlify.app/ebay/` の「担当者ログイン」に作成したログイン名・パスワードを入力して確認します。DBの実接続確認もこのログインで行います。eBay開発者キーと実接続は引き続き未設定です。
