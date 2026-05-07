# withFileLock の仕組み

`pendingOp` という変数に「直前の操作の Promise」を常に持ち続けることで、ファイル操作を直列化しています。

```ts
let pendingOp = Promise.resolve<void>(undefined); // 最初は「何もない」Promise

function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = pendingOp.then(fn);              // 前の操作が終わったら fn を実行
  pendingOp = result.then(() => {}, () => {});    // pendingOp を「fn が終わるまで待つ」に更新
  return result;
}
```

## 時系列で見ると

1. **`appendInbox` が呼ばれる**
   - `result = Promise.resolve().then(appendInbox)` → すぐ実行開始
   - `pendingOp = appendInboxが終わるまで待つPromise`

2. **`shiftInbox` が割り込んで呼ばれる（appendInbox がまだ実行中）**
   - `result = pendingOp.then(shiftInbox)` → appendInbox が終わるまで待機
   - `pendingOp = shiftInboxが終わるまで待つPromise`

「次の操作は前の操作の `.then()` に繋ぐ」を繰り返すことで、自動的に順番待ち行列ができます。

`result.then(() => {}, () => {})` の部分は、操作が失敗しても `pendingOp` が rejected のままにならないようにするためです。失敗で止まると以降の操作が全部待ちっぱなしになるので。

## 3つの関数すべてに withFileLock がある

```ts
export async function appendInbox(...) {
  return withFileLock(async () => { /* 中身 */ });
}

export async function shiftInbox() {
  return withFileLock(async () => { /* 中身 */ });
}

export async function prependInbox(...) {
  return withFileLock(async () => { /* 中身 */ });
}
```

`pendingOp` はモジュールレベルの変数なので、3つの関数が同じキューを共有しています。どの関数が呼ばれても前の操作が終わるまで待つようになっています。
