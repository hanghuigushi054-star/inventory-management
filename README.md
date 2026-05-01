<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/929d8467-e98e-493c-9b01-f641ec4ba9d0

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`
* **主な機能**
📸 AI画像解析による自動入力: Google Gemini AIを活用し、アップロードされたお菓子の画像から「おやつのなまえ」「賞味期限」「かず」を自動抽出します。
✍️ 手動入力対応: 写真認識だけでなく、手動で細かい在庫登録を行うことも可能です。
➕ 自動合算機能: 同じ商品名・同じ賞味期限のおやつが登録された場合、自動で既存のデータに個数を足し合わせます。
📊 スマート在庫ボード: おやつの名前ごとにグループ化し、異なる賞味期限を見やすく一覧表示。合計個数も自動計算されます。
🎛️ 簡単な在庫調整: 一覧ボードからワンボタン（＋ / −）で直感的に個数管理ができ、不要になったデータはごみ箱ボタンで削除できます。
🔐 Googleログイン認証: Firebase Authを利用したセキュアなログインを提供し、ユーザーごとのデータを安全に管理します（Firestore セキュリティルール適用済）。
