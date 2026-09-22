const sel = document.getElementById('cfMinSize');
return JSON.stringify({
  下拉存在: !!sel,
  档位数: sel ? sel.options.length : 0,
  档位值: sel ? [...sel.options].map((o) => o.value).join(',') : null,
  当前值: sel ? sel.value : null,
  localStorage_minSize: localStorage.getItem('nasdy.minSize'),
  顶栏角标: document.getElementById('topCount').textContent,
  item数: document.querySelectorAll('.item').length,
}, null, 1);
