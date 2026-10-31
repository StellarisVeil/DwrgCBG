// 模拟藏宝阁页面的 HTML 生成器
const skinNames = (arr) => arr.map(n => `<div class="card-item"><div class="name-wrap"><span class="name">${n}</span></div></div>`).join('');

// 搜索结果 / 列表页卡片
function card({ title, price, href, skins = [] }) {
  return `<div class="product-item product-item-cards">
    <a class="main-title" href="${href}">${title}</a>
    <div class="row-hd"><span class="price">${price}</span></div>
    <div class="card-item"><div class="name-wrap"><span class="name">${title}</span></div></div>
    ${skinNames(skins)}
  </div>`;
}

function searchPage(keyword, cards) {
  return page(`搜索结果：${keyword}`, `
    <h1>搜索 ${keyword}</h1>
    <div id="list">${cards.map(card).join('')}</div>
  `);
}

function listPage(cards) {
  return page('账号列表', `<div id="list">${cards.map(card).join('')}</div>`);
}

function page(title, body) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font-family:system-ui;padding:16px}.product-item{border:1px solid #ddd;margin:8px 0;padding:8px}</style>
  </head><body>${body}</body></html>`;
}

module.exports = { searchPage, listPage, page };
