const admin = require("firebase-admin");

// 這是從環境變數取得金鑰，如果已經初始化過就跳過
if (!admin.apps.length) {
  // 處理 Netlify 環境變數換行符號的問題
  const privateKey = process.env.FIREBASE_PRIVATE_KEY 
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') 
    : undefined;

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: privateKey,
    }),
  });
}

const db = admin.firestore();

exports.handler = async (event, context) => {
  // 1. 只允許 POST 方法
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    // 2. 解析 Google Sheet 傳來的資料
    const body = JSON.parse(event.body);
    const { csvData, dbSource } = body;

    // 簡單的安全驗證 (建議設定一個 TOKEN)
    const secretToken = process.env.API_SECRET;
    if (secretToken && body.token !== secretToken) {
        return { statusCode: 401, body: "Unauthorized" };
    }

    if (!csvData) {
      return { statusCode: 400, body: "Missing csvData" };
    }

    // 3. 決定寫入的路徑 (跟你的 React 前端一致)
    const appId = dbSource || "default-app-id";
    const docPath = `artifacts/${appId}/public/data/settings/main`;

    // 4. 寫入 Firebase
    await db.doc(docPath).set({ csvData }, { merge: true });

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, message: "資料庫已更新" }),
    };

  } catch (error) {
    console.error("API Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
