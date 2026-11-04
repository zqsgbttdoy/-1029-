// 只读静态语法核验：抽取内联 <script>（无 src）用 new Function 校验，不执行任何页面逻辑。
var fs = require('fs');
var files = process.argv.slice(2);
var bad = 0;
files.forEach(function (f) {
    var html = fs.readFileSync(f, 'utf8');
    var re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    var m, idx = 0;
    while ((m = re.exec(html)) !== null) {
        idx++;
        var code = m[1];
        if (!code.trim()) continue;
        try {
            new Function(code);
            console.log('OK   ' + f + '  [inline#' + idx + ']  len=' + code.length);
        } catch (e) {
            bad++;
            console.log('FAIL ' + f + '  [inline#' + idx + ']  ' + e.message);
        }
    }
});
process.exit(bad ? 1 : 0);
