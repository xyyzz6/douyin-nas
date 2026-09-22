const rows = [...document.querySelectorAll('#brSrc .srow, .br-src .srow')];
return JSON.stringify({
  片源面板可见: !document.getElementById('brSrc').hidden || document.getElementById('brSrc').offsetParent !== null,
  行数: rows.length,
  每行: rows.map((r) => {
    const b = r.querySelector('.fskip');
    return {
      名字: (r.querySelector('.fname')||{}).textContent,
      有开关: !!b,
      开关文案: b ? b.textContent.trim() : null,
      开关on: b ? b.classList.contains('on') : null,
      开关data: b ? b.dataset.skip : null,
    };
  }),
  前端S_config_skipDirs: (window.S && S.config) ? S.config.skipDirs : '(模块作用域，取不到)',
}, null, 1);
