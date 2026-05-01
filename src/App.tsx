/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { GoogleGenAI } from '@google/genai';
import { UploadCloud, Loader2, AlertTriangle, CheckCircle, Package, LogIn, LogOut, Trash2 } from 'lucide-react';
import { auth, db } from './firebase';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User, signOut } from 'firebase/auth';
import { collection, doc, setDoc, serverTimestamp, query, where, onSnapshot, updateDoc, deleteDoc, getDocs } from 'firebase/firestore';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// プロンプトを定義（ユーザーの指示をそのまま使用してシステムロールとして設定）
const SYSTEM_PROMPT = `あなたは、学童保育施設の堅牢な在庫管理システムに組み込まれた「高精度な画像データ抽出モジュール」です。
ユーザーから提供されたお菓子のパッケージや納品書の画像から、システム登録に必要な情報を抽出し、必ず指定されたJSONフォーマットで出力してください。

## 処理のステップと厳格なルール
1. 【おやつ名の特定】: 画像から商品名を正確に読み取ってください。
2. 【賞味期限の特定】: 画像から賞味期限または消費期限を読み取り、「YYYY-MM-DD」の形式に変換してください。
   - ※重要※：文字が潰れている、見切れているなど、少しでも不確実な場合は**絶対に推測（ハルシネーション）をせず、値に \`null\` を設定**してください。誤った賞味期限の登録は重大なインシデントに繋がるため、不確実な場合は人間の手入力を強制させます。
3. 【個数の特定】: 画像から内容量や個数が読み取れる場合は数値を設定してください。読み取れない場合はデフォルト値として \`1\` を設定してください。

## 出力フォーマット（厳守事項）
出力は、プログラムが直接パースして処理を行うため、**以下のJSON形式のみ**で返答してください。挨拶、説明テキスト、マークダウン記法（\`\`\`json などのバッククォート）は一切出力しないでください。

{
  "itemName": "抽出したおやつの名前",
  "expirationDate": "2026-10-31",
  "quantity": 1
}`;

interface ExtractedData {
  itemName: string;
  expirationDate: string | null;
  quantity: number;
}

function InventoryList({ user, showToast }: { user: User | null, showToast: (msg: string, type?: 'success'|'error') => void }) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  useEffect(() => {
    if (!user) {
      setItems([]);
      setLoading(false);
      return;
    }

    const q = query(collection(db, 'inventory'), where('createdBy', '==', user.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const newItems = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      newItems.sort((a, b) => {
        const timeA = a.createdAt?.toMillis() || 0;
        const timeB = b.createdAt?.toMillis() || 0;
        return timeB - timeA;
      });
      setItems(newItems);
      setLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'inventory');
      setLoading(false);
    });

    return () => unsubscribe();
  }, [user]);

  const groupedItems = useMemo(() => {
    const groups: Record<string, typeof items> = {};
    items.forEach(item => {
      if (!groups[item.itemName]) {
        groups[item.itemName] = [];
      }
      groups[item.itemName].push(item);
    });
    // Sort each group by expiration date
    Object.values(groups).forEach(group => {
       group.sort((a, b) => {
         if (!a.expirationDate) return 1;
         if (!b.expirationDate) return -1;
         return a.expirationDate.localeCompare(b.expirationDate);
       })
    });
    // Return sorted keys
    return Object.keys(groups).sort().map(key => ({
      itemName: key,
      totalQuantity: groups[key].reduce((sum, item) => sum + item.quantity, 0),
      items: groups[key]
    }));
  }, [items]);

  const updateQuantity = async (id: string, currentQuantity: number, delta: number) => {
    const newQuantity = currentQuantity + delta;
    if (newQuantity < 0) return;
    try {
      const docRef = doc(db, 'inventory', id);
      await updateDoc(docRef, { quantity: newQuantity });
    } catch (error: any) {
      handleFirestoreError(error, OperationType.UPDATE, `inventory/${id}`);
    }
  };

  const deleteItem = async (id: string) => {
    try {
      const docRef = doc(db, 'inventory', id);
      await deleteDoc(docRef);
      setDeleteConfirm(null);
      showToast("🗑️ おやつを削除しました", "success");
    } catch (error: any) {
      handleFirestoreError(error, OperationType.DELETE, `inventory/${id}`);
      showToast("エラーが発生しました", "error");
    }
  };

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center p-12 bg-white rounded-3xl border-4 border-dashed border-orange-200 col-span-1 md:col-span-2 min-h-[400px]">
        <div className="w-20 h-20 bg-orange-100 rounded-full flex items-center justify-center mb-6 shadow-inner">
          <LogIn className="w-10 h-10 text-orange-400" />
        </div>
        <p className="text-gray-600 font-bold text-lg mb-2">在庫を見るにはログインが必要です</p>
        <p className="text-gray-400 text-sm">右上の「先生ログイン」ボタンからログインしてください！</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center p-20 col-span-1 md:col-span-2">
        <Loader2 className="w-12 h-12 text-orange-400 animate-spin" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-12 bg-white rounded-3xl border-4 border-dashed border-orange-200 col-span-1 md:col-span-2 min-h-[400px]">
        <div className="w-20 h-20 bg-orange-50 rounded-full flex items-center justify-center mb-6 text-4xl shadow-inner border-2 border-orange-100">
          🍩
        </div>
        <p className="text-gray-600 font-bold text-lg text-center leading-relaxed">
          まだおやつが登録されていません。<br/>
          「おやつを登録」タブから追加してね！
        </p>
      </div>
    );
  }

  return (
    <div className="col-span-1 md:col-span-2 bg-white rounded-3xl shadow-[0_8px_30px_rgb(0,0,0,0.06)] border-2 border-orange-200 overflow-hidden">
      <div className="bg-orange-100 px-6 py-4 border-b border-orange-200">
        <h2 className="text-lg font-bold text-orange-700 flex items-center gap-2">
          📋 おやつ在庫管理ボード
        </h2>
      </div>
      <div className="bg-gray-50 p-4">
        <div className="overflow-y-auto max-h-[60vh] md:max-h-[600px] bg-white shadow-sm rounded-xl border border-gray-200 relative scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-transparent">
          <table className="w-full text-left border-collapse min-w-[600px]">
            <thead className="sticky top-0 z-20 bg-gray-100 shadow-[0_1px_3px_rgba(0,0,0,0.1)]">
              <tr className="border-b border-gray-300">
                <th className="px-4 py-2 border-r border-gray-200 font-bold text-gray-700 w-1/3 text-center bg-gray-100 backdrop-blur-sm text-sm">おやつのなまえ</th>
                <th className="px-4 py-2 border-r border-gray-200 font-bold text-gray-700 w-1/3 text-center bg-gray-100 backdrop-blur-sm text-sm">賞味期限</th>
                <th className="px-4 py-2 font-bold text-gray-700 w-1/3 text-center bg-gray-100 backdrop-blur-sm text-sm">かず (増減)</th>
              </tr>
            </thead>
          <tbody>
            {groupedItems.map(group => {
               return (
                 <React.Fragment key={group.itemName}>
                   {group.items.map((item, index) => (
                     <tr key={item.id} className="border-b border-gray-200 hover:bg-orange-50/50 transition-colors">
                       {index === 0 && (
                         <td className="px-4 py-2 border-r border-gray-200 align-top bg-white/50" rowSpan={group.items.length}>
                           <div className="font-bold text-gray-800 text-base">{group.itemName}</div>
                           {group.items.length > 1 && (
                             <div className="text-xs text-orange-600 font-bold bg-orange-100 inline-block px-2 py-0.5 rounded-full mt-1 shadow-sm border border-orange-200">
                               合計: {group.totalQuantity} 個
                             </div>
                           )}
                         </td>
                       )}
                       <td className="px-4 py-2 border-r border-gray-200 align-middle text-center">
                         {item.expirationDate ? (
                           <span className="font-mono text-gray-700 bg-gray-50 px-2 py-1 border border-gray-200 rounded-md text-xs shadow-sm">{item.expirationDate}</span>
                         ) : (
                           <span className="text-red-500 font-bold text-xs bg-red-50 border border-red-100 px-2 py-1 rounded-md shadow-sm">未設定</span>
                         )}
                       </td>
                       <td className="px-4 py-2 align-middle">
                          <div className="flex items-center justify-center gap-3">
                            <button 
                               onClick={() => updateQuantity(item.id, item.quantity, -1)}
                               className="w-8 h-8 rounded-full bg-gray-50 hover:bg-red-50 hover:text-red-600 hover:border-red-200 border border-gray-200 flex items-center justify-center text-lg font-bold transition-all shadow-sm disabled:opacity-50 disabled:cursor-not-allowed text-gray-500"
                               disabled={item.quantity <= 0}
                            >-</button>
                            <span className="font-black text-xl text-orange-600 w-10 text-center">{item.quantity}</span>
                            <button 
                               onClick={() => updateQuantity(item.id, item.quantity, 1)}
                               className="w-8 h-8 rounded-full bg-gray-50 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 border border-gray-200 flex items-center justify-center text-lg font-bold transition-all shadow-sm text-gray-500"
                            >+</button>
                            {deleteConfirm === item.id ? (
                               <div className="flex items-center gap-1 ml-1">
                                  <span className="text-[10px] text-red-500 font-bold whitespace-nowrap">消す？</span>
                                  <button onClick={() => deleteItem(item.id)} className="px-2 py-1 h-7 rounded bg-red-50 hover:bg-red-500 hover:text-white border border-red-200 text-red-500 flex items-center justify-center font-bold text-xs shadow-sm">はい</button>
                                  <button onClick={() => setDeleteConfirm(null)} className="px-2 py-1 h-7 rounded bg-gray-50 hover:bg-gray-200 border border-gray-200 text-gray-500 flex items-center justify-center font-bold text-xs shadow-sm">戻る</button>
                               </div>
                            ) : (
                               <button 
                                  onClick={() => setDeleteConfirm(item.id)}
                                  className="ml-1 w-8 h-8 rounded-full bg-gray-50 hover:bg-red-500 hover:text-white border border-gray-200 flex items-center justify-center transition-all shadow-sm text-gray-400 flex-shrink-0"
                                  title="削除"
                               >
                                  <Trash2 className="w-4 h-4" />
                               </button>
                            )}
                          </div>
                       </td>
                     </tr>
                   ))}
                 </React.Fragment>
               )
            })}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'register' | 'inventory'>('register');
  const [toast, setToast] = useState<{message: string, type: 'success'|'error'} | null>(null);

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);
  const [image, setImage] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [data, setData] = useState<ExtractedData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (e) {
      console.error(e);
      showToast("ログインに失敗しました", "error");
    }
  };

  const handleLogout = async () => {
    await signOut(auth);
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve((reader.result as string).split(',')[1]);
      reader.onerror = error => reject(error);
    });
  };

  const processFile = async (file: File) => {
    setImage(file);
    setPreviewUrl(URL.createObjectURL(file));
    setIsProcessing(true);
    setData(null);
    setError(null);

    try {
      const base64data = await fileToBase64(file);
      // 環境変数からGemini APIキーを取得
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      const apiKey = process.env.GEMINI_API_KEY;

      if (!apiKey) {
        throw new Error('APIキーが設定されていません。AI StudioのSettingsからGEMINI_API_KEYを設定してください。');
      }

      const ai = new GoogleGenAI({ apiKey });

      const response = await ai.models.generateContent({
        // 画像認識に優れた2.5-flashを使用
        model: "gemini-2.5-flash",
        contents: [
          {
            role: 'user',
            parts: [
              { text: SYSTEM_PROMPT },
              { inlineData: { data: base64data, mimeType: file.type } }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json",
        }
      });

      const responseText = response.text;
      if (responseText) {
        try {
          // LLMがマークダウンを出力してしまった場合のフォールバック処理
          const cleanJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
          const parsed = JSON.parse(cleanJson);
          setData({
            itemName: parsed.itemName || '',
            expirationDate: parsed.expirationDate === "null" ? null : (parsed.expirationDate || null),
            quantity: parsed.quantity || 1
          });
        } catch (err) {
          console.error("JSON Parse Error:", err, responseText);
          setError("解析結果の読み取りに失敗しました。画像が不明瞭な可能性があります。");
        }
      } else {
        setError("解析結果を取得できませんでした。");
      }

    } catch (err: any) {
      console.error(err);
      setError(err.message || '通信エラーが発生しました。時間を置いて再度お試しください。');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFile(e.target.files[0]);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      // 画像ファイルのみを許可
      if (e.dataTransfer.files[0].type.startsWith('image/')) {
        processFile(e.dataTransfer.files[0]);
      } else {
        setError("画像ファイル（PNG, JPG等）をアップロードしてください。");
      }
    }
  }, []);

  const handleReset = () => {
    setImage(null);
    setPreviewUrl(null);
    setData(null);
    setError(null);
    if (fileInputRef.current) {
        fileInputRef.current.value = '';
    }
  };

  const handleSave = async () => {
    if (!user) {
      showToast("保存するにはログインが必要です", "error");
      return;
    }
    
    if (!data) return;

    try {
      const q = query(
        collection(db, 'inventory'),
        where('createdBy', '==', user.uid),
        where('itemName', '==', data.itemName),
        where('expirationDate', '==', data.expirationDate || null)
      );
      
      const querySnapshot = await getDocs(q);

      if (!querySnapshot.empty) {
        const existingDoc = querySnapshot.docs[0];
        const currentData = existingDoc.data();
        const newQuantity = (currentData.quantity || 0) + data.quantity;
        
        await updateDoc(doc(db, 'inventory', existingDoc.id), {
          quantity: newQuantity
        });
        showToast(`✨ すでにある「${data.itemName}」に ${data.quantity}個 追加しました！(合計: ${newQuantity}個)`);
      } else {
        const docRef = doc(collection(db, 'inventory'));
        await setDoc(docRef, {
          itemName: data.itemName,
          quantity: data.quantity,
          expirationDate: data.expirationDate,
          createdBy: user.uid,
          createdAt: serverTimestamp()
        });
        showToast("✨ 新しく保存しました！");
      }
      handleReset();
    } catch (error: any) {
      handleFirestoreError(error, OperationType.WRITE, 'inventory');
      showToast("エラーが発生しました", "error");
    }
  };

  return (
    <div className="min-h-screen bg-[#FFFBF0] font-sans text-gray-700 flex flex-col pt-0 selection:bg-orange-200">
      {/* Header Navigation */}
      <header className="h-16 border-b-4 border-orange-200 bg-white flex items-center justify-between px-4 md:px-8 flex-shrink-0 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-orange-400 rounded-full flex items-center justify-center font-bold text-white shadow-md shadow-orange-200">
            <Package className="w-5 h-5" />
          </div>
          <span className="text-xl font-extrabold text-orange-600 tracking-tight">おやつ在庫メモ 🍪</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="hidden md:flex items-center gap-2 text-sm font-bold text-emerald-500 bg-emerald-50 px-3 py-1 rounded-full border border-emerald-100">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
            AI準備OK
          </div>
          {user ? (
            <div className="flex items-center gap-2 ml-2">
              <div className="w-9 h-9 rounded-full bg-orange-100 border-2 border-orange-200 flex items-center justify-center text-orange-500 font-bold shadow-inner overflow-hidden">
                 {user.photoURL ? <img src={user.photoURL} alt="User" className="w-full h-full object-cover" /> : "先"}
              </div>
              <span className="text-sm font-bold text-gray-600 hidden sm:block truncate max-w-[120px]">{user.displayName || '先生アカウント'}</span>
              <button onClick={handleLogout} className="ml-2 hover:bg-orange-50 p-2 rounded-full transition-colors text-orange-400 hover:text-orange-600" title="ログアウト">
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          ) : (
            <button onClick={handleLogin} className="flex items-center gap-2 ml-2 bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-full font-bold shadow-md transition-all text-sm">
              <LogIn className="w-4 h-4" />
              先生ログイン
            </button>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-6xl w-full mx-auto flex flex-col gap-8 p-4 md:p-8">
        
        {/* Tabs */}
        <div className="flex justify-center -mb-2 mt-2">
          <div className="inline-flex bg-orange-100 p-1.5 rounded-full shadow-inner">
            <button 
              onClick={() => setActiveTab('register')}
              className={`px-8 py-3 rounded-full text-base font-bold transition-all flex items-center gap-2 ${activeTab === 'register' ? 'bg-white text-orange-600 shadow-md transform scale-105' : 'text-orange-500 hover:bg-orange-200 hover:text-orange-700'}`}
            >
              📝 おやつを登録
            </button>
            <button 
              onClick={() => setActiveTab('inventory')}
              className={`px-8 py-3 rounded-full text-base font-bold transition-all flex items-center gap-2 ${activeTab === 'inventory' ? 'bg-white text-orange-600 shadow-md transform scale-105' : 'text-orange-500 hover:bg-orange-200 hover:text-orange-700'}`}
            >
              📦 在庫を見る
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {activeTab === 'register' ? (
            <>
              {/* 左カラム: 画像アップロード・プレビュー */}
              <section className="flex flex-col gap-4">
                <div className="flex items-center justify-between pl-2">
            <h2 className="text-lg font-bold text-orange-700 flex items-center gap-2">
              <span className="bg-orange-100 text-orange-600 w-6 h-6 rounded-full inline-flex items-center justify-center text-sm shadow-sm">1</span>
              パッケージをパシャ！📸
            </h2>
          </div>
          
          <div className="flex-1 min-h-[350px] bg-white rounded-3xl border-4 border-dashed border-orange-200 relative flex items-center justify-center overflow-hidden shadow-[0_8px_30px_rgb(0,0,0,0.04)]">
            {previewUrl ? (
              <div className="relative w-full h-full group flex items-center justify-center p-4">
                <img src={previewUrl} alt="Preview" className="w-auto h-auto max-w-full max-h-full object-contain rounded-xl shadow-md" />
                <div className="absolute inset-0 bg-white/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center backdrop-blur-sm z-20">
                  <button 
                    onClick={handleReset} 
                    className="px-6 py-3 bg-white text-orange-600 border-2 border-orange-300 rounded-full font-bold shadow-xl hover:bg-orange-50 hover:scale-105 transition-all text-lg"
                  >
                    別の画像をえらぶ
                  </button>
                </div>
              </div>
            ) : (
              <div
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`
                  w-full h-full flex flex-col items-center justify-center cursor-pointer transition-all p-8 text-center absolute inset-0 z-10
                  ${isDragging ? 'bg-orange-50 scale-[1.02]' : 'hover:bg-orange-50/50'}
                `}
              >
                <div className={`mb-6 w-24 h-24 rounded-full flex items-center justify-center transition-colors shadow-inner ${isDragging ? 'bg-orange-200' : 'bg-orange-50'}`}>
                  <UploadCloud className={`w-12 h-12 ${isDragging ? 'text-orange-600' : 'text-orange-400'}`} />
                </div>
                <p className="text-gray-600 font-bold mb-2 text-lg leading-relaxed">
                  <span className="text-orange-500 hover:text-orange-600 underline decoration-orange-300 underline-offset-4">ファイルを選択</span> または<br/>ここにドラッグ＆ドロップ！
                </p>
                <p className="text-sm text-gray-400 font-medium mt-2 bg-gray-50 px-3 py-1 rounded-full inline-block">スマホの写真もOKです📱</p>
              </div>
            )}
          </div>
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            accept="image/*"
            capture="environment"
            onChange={handleFileChange}
          />
        </section>

        {/* 右カラム: データ確認・編集・登録 */}
        <section className="flex flex-col gap-4">
          <div className="flex items-center justify-between pl-2">
            <h2 className="text-lg font-bold text-orange-700 flex items-center gap-2">
              <span className="bg-orange-100 text-orange-600 w-6 h-6 rounded-full inline-flex items-center justify-center text-sm shadow-sm">2</span>
              読み込んだデータ ✨
            </h2>
          </div>
          
          <div className="flex-1 bg-white border-2 border-orange-100 rounded-3xl p-6 shadow-[0_8px_30px_rgb(0,0,0,0.06)] flex flex-col min-h-[350px] relative overflow-hidden">
            
            {isProcessing ? (
              <div className="absolute inset-0 bg-white/80 backdrop-blur-sm z-10 flex flex-col items-center justify-center">
                <div className="relative">
                  <div className="absolute inset-0 bg-yellow-200 rounded-full blur-xl opacity-60 animate-pulse"></div>
                  <Loader2 className="w-12 h-12 text-orange-500 animate-spin relative z-20 mb-4 mx-auto" />
                </div>
                <p className="text-orange-600 font-bold text-lg animate-pulse bg-white/80 px-4 py-2 rounded-full shadow-sm mt-2">
                  AIが一生懸命よみこみ中... 🔍
                </p>
              </div>
            ) : error ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
                <div className="p-4 bg-red-50 border-2 border-red-100 rounded-full flex items-center justify-center mb-4">
                  <AlertTriangle className="w-10 h-10 text-red-500" />
                </div>
                <p className="text-red-500 font-bold text-lg mb-2">あ、エラーが起きました💦</p>
                <p className="text-gray-500 text-sm bg-gray-50 p-4 rounded-xl">{error}</p>
              </div>
            ) : !data ? (
               <div className="flex-1 flex flex-col items-center justify-center text-center p-6 border-2 border-dashed border-gray-100 rounded-2xl m-2 bg-gray-50/50">
                  <div className="w-20 h-20 bg-white rounded-full flex items-center justify-center mb-4 text-4xl shadow-sm border border-gray-100">
                     🍩
                  </div>
                  <p className="text-gray-500 font-bold leading-relaxed mb-6">写真を選ぶと、ここに<br/>おやつの情報が表示されます！</p>
                  <button 
                    onClick={() => setData({ itemName: '', expirationDate: '', quantity: 1 })}
                    className="px-6 py-3 bg-white border-2 border-orange-200 text-orange-600 rounded-full font-bold shadow-sm hover:bg-orange-50 transition-colors"
                  >
                    ✍️ 自分で手入力する
                  </button>
               </div>
            ) : (
              <div className="flex-1 flex flex-col space-y-6">
                
                {/* Inputs Container */}
                <div className="space-y-5 flex-1">
                  {/* おやつ名 */}
                  <div>
                    <label className="block text-sm font-bold text-gray-600 mb-2 ml-1">🍬 おやつのなまえ</label>
                    <input
                      type="text"
                      value={data.itemName || ''}
                      onChange={(e) => setData({ ...data, itemName: e.target.value })}
                      className="w-full bg-gray-50 border-2 border-gray-200 rounded-2xl p-4 text-gray-800 text-lg font-bold focus:bg-white focus:border-orange-400 focus:ring-4 focus:ring-orange-100 outline-none transition-all placeholder-gray-400 text-center sm:text-left"
                      placeholder="例：たべっ子どうぶつ"
                    />
                  </div>

                  <div className="flex flex-col sm:flex-row gap-5">
                    {/* 賞味期限 */}
                    <div className="flex-1">
                      <label className="block text-sm font-bold text-gray-600 mb-2 ml-1">🗓 賞味期限</label>
                      <input
                        type="date"
                        value={data.expirationDate || ''}
                        onChange={(e) => setData({ ...data, expirationDate: e.target.value })}
                        className={`w-full rounded-2xl p-4 text-lg font-bold outline-none transition-all text-center sm:text-left focus:ring-4 focus:ring-orange-100 
                          ${data.expirationDate === null 
                            ? 'border-2 border-red-300 bg-red-50 text-red-800 focus:bg-white focus:border-red-400 focus:ring-red-100' 
                            : 'border-2 border-gray-200 bg-gray-50 focus:bg-white focus:border-orange-400 text-gray-800'}`}
                      />
                      {data.expirationDate === null && (
                        <p className="mt-3 text-[13px] font-bold text-red-500 bg-red-50 p-3 rounded-xl border border-red-100">
                          ⚠️ 写真から読み取れませんでした。<br className="sm:hidden" />手入力してください！
                        </p>
                      )}
                    </div>

                    {/* 個数 */}
                    <div className="w-full sm:w-32">
                      <label className="block text-sm font-bold text-gray-600 mb-2 ml-1">📦 かず</label>
                      <div className="relative">
                        <input
                          type="number"
                          min="1"
                          value={data.quantity || 1}
                          onChange={(e) => setData({ ...data, quantity: parseInt(e.target.value) || 1 })}
                          className="w-full bg-gray-50 border-2 border-gray-200 rounded-2xl p-4 text-gray-800 text-lg font-bold focus:bg-white focus:border-orange-400 focus:ring-4 focus:ring-orange-100 outline-none transition-all pr-8 text-center sm:text-right"
                        />
                        <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 font-bold pointer-events-none hidden sm:block">個</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* アクションボタン */}
                <div className="flex flex-col sm:flex-row gap-3 mt-6 pt-4 border-t-2 border-dashed border-gray-100">
                  <button 
                    onClick={handleReset}
                    className="flex-1 bg-white border-2 border-gray-200 text-gray-600 hover:bg-gray-50 py-4 rounded-2xl text-base font-bold transition-colors shadow-sm"
                  >
                    やり直す
                  </button>
                  <button
                    onClick={handleSave} 
                    className="flex-[2] bg-orange-500 hover:bg-orange-600 py-4 rounded-2xl text-base font-bold shadow-lg shadow-orange-200 transition-all text-white hover:-translate-y-1 active:translate-y-0 disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    <CheckCircle className="w-6 h-6" />
                    データベースに保存
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
            </>
          ) : (
            <InventoryList user={user} showToast={showToast} />
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="py-6 text-center text-sm font-bold text-orange-300 mt-auto flex-shrink-0">
        ☆ GAKUDOU DATA SYSTEMS ☆
      </footer>

      {/* Toast Notification */}
      {toast && (
        <div className={`fixed bottom-4 right-4 p-4 rounded-xl shadow-lg font-bold z-50 animate-bounce text-sm ${toast.type === 'success' ? 'bg-emerald-500 text-white' : 'bg-red-500 text-white'}`}>
          {toast.message}
        </div>
      )}
    </div>
  );
}