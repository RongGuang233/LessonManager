// This module never persists credentials in browser storage or form drafts.
export function newTuitionKey(cryptoSource = globalThis.crypto) {
  const bytes = cryptoSource.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes));
}

export function publicationMessage(result) {
  const count = Number(result.students) || 0;
  const pending = Number(result.unverified) || 0;
  return `已发布 ${count} 位学生的学费余额${pending ? `，其中 ${pending} 位仍待核对` : ''}。请在订阅簿点击“刷新学费余额”。${result.statusSaved === false ? '本机未能保存发布时间，请解锁钥匙串。' : ''}`;
}
