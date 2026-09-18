# AILIS eBay アカウント削除通知：導入手順

作成日：2026-09-18
基準ファイル：AILIS202609181101(2).zip
対象：my-openai-proxy-new の共通eBayサーバー
状態：ローカル実装・検証済み。本番未反映。eBayでの登録はまだ行わない。

## 1. 今回追加したもの

ProductionのMarketplace Account Deletion通知を受け取る専用のNetlify Functionです。

- GETの登録確認：challenge_code、Verification token、登録するURLをこの順でSHA-256に渡し、JSONのchallengeResponseを返します。
- POSTの通知確認：X-EBAY-SIGNATUREをeBayの公開鍵で検証し、正規の通知だけを処理します。
- 通知された利用者の識別子に紐づく保存データを、既存PostgreSQLのトランザクションで削除します。
- 認証情報を一時的に確認している間も削除対象を特定できるよう、非公開の識別情報を接続設定に保持します。
- 新たな出品前検査の結果にも、接続アカウントの識別子を紐づけます。検査失敗時の応答も対象です。
- 同じ通知が再送されても、対象外のデータを巻き込まない処理です。
- 検証失敗・DB障害時は成功を返さず、eBayが再試行できるようにします。

既存の出品用APIとURLを分離します。既存APIのログイン・CSRF確認を解除しません。
この処理は、併売先で売れた商品の品下げ機能ではありません。
出品・品下げ・注文キャンセル・販売用アカウントの削除をeBayへ要求するAPIは呼びません。

## 2. 変更しないもの

AILISの入力ページ、TCG、デニム、ガスガン、楽天・ヤフオク・オンラインの拡張機能は変更しません。
楽天の置き配機能は保留のままです。
商品名・説明・価格・画像の出品内容を作る処理は変更しません。
公開画面のebay/index.html、ebay/app.js、ebay/style.cssと、core/ebayConnection.jsは変更しません。
portalUrlは未設定のままです。
新しいサーバー契約や、新規DB・新規テーブルの作成は行いません。
既存のdb/ebay.sqlとpackage-lock.jsonは置換不要です。依存パッケージの追加もありません。

## 3. ファイルの配置

ZIPは差し替え・追加ファイルだけです。既存のmy-openai-proxy-newフォルダに重ねます。
フォルダを丸ごと削除しないでください。
AILIS/yrtools_minami/AILISへ入れるファイルではありません。
PC上の上書きだけでは、Netlifyの本番サイトには反映されません。

変更する既存ファイル：
- lib/ebay/store.js
- lib/ebay/service.js
- package.json
- scripts/build-ebay.cjs

追加する実行ファイル：
- lib/ebay/account-deletion.js
- lib/ebay/account-deletion-store.js
- netlify/functions/ebay-account-deletion.mjs

追加する補助・検証ファイル：
- tools/ebay-deletion-setup.html
- tests/ebay-account-deletion.test.js
- tests/fixtures/ebay-deletion-official.json
- tests/fixtures/ebay-deletion-official-NOTICE.txt
- tests/fixtures/ebay-notification-sdk-LICENSE.txt
- EBAY_ACCOUNT_DELETION_SETUP.md

## 4. 本番へ反映する前に確認すること

既存資料に記載されたNetlifyプロジェクト名はailis-ebay、eBay用ブランチはcodex/ebay-trading-shared-browserです。
この資料の記載だけで現在の本番設定が同一とは扱わず、接続先・配信ブランチ・Functionsの設定を確認します。
既存mainと既存のVercel側APIをこの作業で更新しません。
全体ZIPやリポジトリのルートを静的公開フォルダに指定しません。
通知用の公開URLはスタッフのログインを要求しない必要があります。出品画面のログインは維持します。
サイト全体のアクセス制限によりeBayから通知先に到達できない場合は、公開範囲を確認してから対処します。

### バックアップと保存範囲

本実装が自動処理するのは、現行スキーマの稼働中の共通DBです。
対象は接続設定、eBayに紐づく検査結果・出品準備・画像URL・送信記録、および関連する一時画像データです。
同じ利用者のSandboxデータはProduction通知で削除しません。
未知の利用者の通知では、対象がないことを確認し、他の利用者のデータを変更しません。
識別子のないAILIS入力データを、推測で別の利用者へ関連付けて全削除する処理はありません。
旧版の検査結果は、保存済み識別子から対応できるものだけを扱います。
紐づけのない過去データや、このコード以外の保存経路がある場合は導入前の確認が必要です。

Neonの復元履歴・別ブランチ・外部バックアップ・各PCへのコピーまで、このプログラムから削除する実装ではありません。
eBayは適切かつ復元できない形でのデータ削除を求めています。稼働DBでDELETEしただけで規約対応全体が完了したとは扱いません。
本番登録前に複製・復元履歴の有無と保持期間を確認し、削除対象が復元で戻らない運用を確定してください。
古いバックアップを本番へそのまま復元して再接続してはいけません。
将来、注文・購入者情報や別DBへの保存を追加する際は、その保存先も削除対象に追加して検証します。

## 5. 管理者が登録する環境変数

既存NetlifyプロジェクトのProduction環境だけに設定します。
値そのものはチャット・GitHub・共有HTMLに貼り付けません。

| 変数名 | 値 |
|---|---|
| EBAY_DELETION_ENDPOINT | 反映後の通知先HTTPS URL。末尾スラッシュなし |
| EBAY_DELETION_VERIFICATION_TOKEN | この通知用に生成した32～80文字の文字列 |
| EBAY_PRODUCTION_CLIENT_ID | 発行済みのProduction App ID / Client ID |
| EBAY_PRODUCTION_CLIENT_SECRET | 同じProductionキーセットのCert ID / Client Secret |
| DATABASE_URL | 既存の共通DB接続設定を利用。新規作成・再発行は不要 |

ProductionのApp ID/Client Secretは、POST通知の署名確認に必要なeBay公開鍵を取得するために使います。
この時点では、販売用アカウントのOAuth接続やRuNameの登録はまだ不要です。
登録確認用GETは、App ID/Client SecretやDBが未接続でも、通知先URLとVerification tokenの設定だけで応答します。
ただし、GET確認に通るだけで運用開始してはいけません。POST通知まで必ず確認します。

既存資料のURLに合わせた候補は次のとおりです。未反映なので、今すぐeBayへ登録する値ではありません。

```text
https://ailis-ebay.netlify.app/api/ebay-account-deletion
```

tools/ebay-deletion-setup.htmlをPC内で開くと、Verification tokenを生成できます。
64文字のランダム値を作り、上の最初の2変数をまとめてコピーできます。
ファイル自体に固定の秘密値はありません。外部通信や永続保存を行いません。
生成した値はNetlifyとeBayの両方へ同じものを登録します。
すでに登録した後で新しい値を生成し直すと不一致になるので、不用意に変更しないでください。
Client Secretはこの補助画面に入力しません。

## 6. 反映後の確認順序

1. コードレビューとローカル検証結果を確認します。
2. 上の保存範囲・バックアップの運用を確認します。
3. 既存のeBay用Netlifyプロジェクトへファイルを反映します。Productionの環境変数を設定した後に再デプロイします。
4. 通知先URLへのGETでchallengeResponseが正しく返ること、未設定・異常時に失敗することを確認します。
5. eBayのAlerts & Notificationsへ戻ります。ProductionとMarketplace Account Deletionはそのままです。
6. 保存済みメールアドレスは変更しません。通知先URLとVerification tokenを登録してSaveします。
7. eBayの確認要求が通り、設定が保存されたことを確認します。
8. Send Test Notificationを押し、POST通知の成功を確認します。
9. Netlifyのログでebay_account_deletion_completedを確認します。テスト通知でも署名確認を省きません。
10. Application Keysで本番キーの状態を確認します。ここまで完了してから、販売用eBayアカウントとの接続へ進みます。

テストが503になる場合は、App ID/Client Secretの登録・本番キーの有効化・DB接続・Functionsの到達性を確認します。
原因を確認せず、常に204を返すように変更してはいけません。

## 7. ローカル検証

開発者向けの実行コマンドです。通常の担当者PCにNode.jsを入れる運用を要求するものではありません。

```text
npm test
node scripts/build-ebay.cjs
```

eBay通信は模擬応答です。公式公開テストベクトルを使ったECDSA署名の暗号検証は実際に行います。
DBテストはPGliteの一時メモリ上で、同じSQLとトランザクションを動かします。Neonの本番には接続しません。
Sandboxアカウントも使用しません。
Node.js 22.16.0で検証しました。Netlify側のNode.js 24での本番配信・実通知受信は未実施です。
新しい関数を含むNetlifyの配布物・コールドスタート確認は、本番反映段階で行います。

HTTP応答：
- 200：GETの確認要求に正常応答。
- 204：POSTの署名検証と、該当データの処理が完了。対象が存在しない場合も含む。
- 400：通知形式や入力が不正。
- 405：GET/POST以外。
- 412：署名がない、改ざん、未対応の署名形式。
- 413：通知データが64KiBを超える。
- 415：JSONでないPOST。
- 503：環境変数・eBayへの確認通信・DB処理を完了できない。成功と扱わず再試行対象。

ログには状態コードだけを残し、通知本文・利用者識別子・秘密キー・トークンを記録しません。
公開鍵はサーバーのプロセス内で1時間キャッシュします。受信ごとの取得を避けます。

## 8. 参照した公式資料

- eBay Marketplace User Account Deletion
  https://developer.ebay.com/develop/guides/sell/marketplace-user-account-deletion
- eBay Event Notification Node.js SDK
  https://github.com/eBay/event-notification-nodejs-sdk
- 署名検証の公式公開テストデータ
  https://github.com/eBay/event-notification-nodejs-sdk/blob/main/test/test.json
- 公式SDKのライセンス
  https://github.com/eBay/event-notification-nodejs-sdk/blob/main/LICENSE.md

付属の公式テストデータはVALIDオブジェクトのみを使用し、出典・ライセンスを同梱しています。
