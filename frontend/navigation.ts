// 记录上一个地址：详情页的返回链接据此决定是后退（保留列表的筛选和滚动位置）还是直接跳转。
let current = location.hash,
  previous = "";
window.addEventListener("hashchange", () => {
  previous = current;
  current = location.hash;
});
export const previousHash = () => previous;
