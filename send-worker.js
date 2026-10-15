// 送人概率的后台计算线程（send-app.js 使用）：收到 { id, cfg }，算完回复 { id, result } 或 { id, error }。
// 在后台算，设置复杂、要算一两秒时页面也不会卡住
importScripts('killprob.js', 'send.js');

self.onmessage = (e) => {
  const { id, cfg } = e.data;
  try {
    self.postMessage({ id, result: self.Send.run(cfg) });
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
