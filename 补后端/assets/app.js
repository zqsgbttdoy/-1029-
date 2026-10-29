/*
 * 监理现场管理系统 - 前端统一基座
 * 统一契约：
 *   响应体 ApiResponse { code:200, message, data }
 *   分页体 PageResult  { list, total, pageNum, pageSize }
 * 提供：登录态管理、统一 fetch 封装（自动注入 Bearer、401 跳转、错误 Toast）、分页封装、顶栏初始化。
 * 用法：各页面 <head> 中引入 <script src="assets/app.js"></script>，并在脚本入口调用 App.requireAuth()。
 */
(function (global) {
    'use strict';

    var API_PREFIX = '/api';
    var LOGIN_PAGE = 'login.html';

    // ---------------- 登录态 ----------------
    // 登录凭证只属于当前标签页；一次写入完整会话，避免用户名、角色与令牌分属不同账号。
    var SESSION_KEY = 'supervision.session.v2';
    var LOGOUT_PREFIX = 'supervision.logout.';
    var sessionVersion = 0;
    var identityRequest = null;
    var legacyKeys = ['token', 'userId', 'userName', 'avatar', 'roles', 'permissions', 'userAvatar', 'userSettings'];
    function removeLegacySession() {
        legacyKeys.forEach(function (k) {
            try { localStorage.removeItem(k); } catch (e) { /* 禁用持久存储不影响退出 */ }
        });
    }
    removeLegacySession();

    function readSession() {
        try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || '{}') || {}; }
        catch (e) { return {}; }
    }
    function tokenId(token) {
        try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).jti || ''; }
        catch (e) { return ''; }
    }
    function isRevoked(token) {
        var id = tokenId(token);
        try { return !!id && Number(localStorage.getItem(LOGOUT_PREFIX + id)) > Date.now(); }
        catch (e) { return false; }
    }
    function getToken() {
        var token = readSession().token || '';
        return isRevoked(token) ? '' : token;
    }
    function getUser() {
        var data = getToken() ? readSession() : {};
        return { userId: data.userId || '', userName: data.userName || '', avatar: data.avatar || '', roles: data.roles || [] };
    }
    function saveSession(data) {
        if (!data) return;
        var old = readSession();
        if (data.token && data.token !== old.token) {
            clearSession();
            old = {};
        }
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({
            token: data.token || old.token || '', userId: data.userId,
            userName: data.userName || '', avatar: data.avatar || '', roles: data.roles || []
        }));
    }
    function clearSession() {
        sessionVersion++;
        identityRequest = null;
        try {
            sessionStorage.removeItem(SESSION_KEY);
            legacyKeys.forEach(function (k) { sessionStorage.removeItem(k); });
            Object.keys(sessionStorage).filter(function (k) { return k.indexOf('field-pc:') === 0; })
                .forEach(function (k) { sessionStorage.removeItem(k); });
        } catch (e) { /* 存储不可用时仍允许返回登录页 */ }
        removeLegacySession();
    }

    function isLoginPage() {
        return /login\.html$/i.test(location.pathname);
    }

    function redirectToLogin() {
        clearSession();
        if (!isLoginPage()) {
            document.documentElement.style.visibility = 'hidden';
            if (document.body) document.body.replaceChildren();
            location.replace(LOGIN_PAGE);
        }
    }

    // 页面守卫：无 token 立即跳登录页
    function requireAuth() {
        if (!getToken()) {
            redirectToLogin();
            return false;
        }
        return true;
    }

    function logout() {
        var token = getToken();
        var id = tokenId(token);
        // 只广播该次登录的失效标记，不共享凭证，不踢出其他独立登录的标签页。
        if (id) {
            try {
                var exp = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp;
                localStorage.setItem(LOGOUT_PREFIX + id, String(exp * 1000));
            } catch (e) { /* 后端仍会撤销令牌 */ }
        }
        var request = Promise.resolve();
        if (token) {
            try {
                request = fetch(API_PREFIX + '/auth/logout', {
                    method: 'POST', headers: { Authorization: 'Bearer ' + token }, keepalive: true
                }).catch(function () { /* 离线时也必须完成本地退出 */ });
            } catch (e) { /* 同步网络异常也不能阻塞退出 */ }
        }
        redirectToLogin();
        return request;
    }

    // ---------------- Toast ----------------
    var forwardingToast = false;
    function toast(msg, type) {
        // 若页面已有自定义 showToast/showNotifToast，优先复用其样式表现
        if (!forwardingToast && typeof global.showToast === 'function' && global.showToast !== toast) {
            forwardingToast = true;
            try { global.showToast(msg, type); return; } catch (e) { /* fallthrough */ }
            finally { forwardingToast = false; }
        }
        var existing = document.querySelector('.app-toast');
        if (existing) existing.remove();
        var el = document.createElement('div');
        el.className = 'app-toast app-toast-' + (type || 'info');
        el.textContent = msg;
        el.style.cssText = 'position:fixed;top:24px;left:50%;transform:translateX(-50%);z-index:9999;'
            + 'padding:10px 20px;border-radius:8px;color:#fff;font-size:14px;box-shadow:0 6px 20px rgba(0,0,0,.18);'
            + 'transition:opacity .3s;opacity:0;'
            + 'background:' + (type === 'error' ? '#EF4444' : type === 'warning' ? '#F59E0B' : type === 'success' ? '#10B981' : '#2563EB') + ';';
        document.body.appendChild(el);
        setTimeout(function () { el.style.opacity = '1'; }, 10);
        setTimeout(function () { el.style.opacity = '0'; setTimeout(function () { if (el.parentElement) el.remove(); }, 300); }, 2500);
    }

    // ---------------- 自定义确认弹窗（替代原生 confirm，Promise<boolean>） ----------------
    // 用法：App.confirm('确定删除吗？', { danger:true, okText:'确认删除' }).then(function(ok){ if(ok){ ... } });
    function confirmDialog(message, options) {
        options = options || {};
        return new Promise(function (resolve) {
            var overlay = document.createElement('div');
            overlay.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10000;align-items:center;justify-content:center;';
            var title = options.title || '操作确认';
            var okText = options.okText || '确认';
            var cancelText = options.cancelText || '取消';
            var okBg = options.danger === false ? '#2563EB' : '#EF4444';
            var btn = 'padding:8px 18px;border-radius:6px;font-size:13px;cursor:pointer;border:none;';
            overlay.innerHTML = '<div style="background:#fff;border-radius:12px;width:400px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,.2);">'
                + '<div style="padding:18px 24px;border-bottom:1px solid #E5E7EB;font-size:16px;font-weight:600;color:#1E3A5F;">' + escape(title) + '</div>'
                + '<div style="padding:26px 24px;text-align:center;">'
                + '<div style="font-size:40px;margin-bottom:12px;">' + (options.icon || '⚠️') + '</div>'
                + '<div style="font-size:14px;color:#374151;line-height:1.6;">' + escape(message) + '</div></div>'
                + '<div style="padding:16px 24px;border-top:1px solid #E5E7EB;display:flex;justify-content:flex-end;gap:12px;">'
                + '<button type="button" data-act="cancel" style="' + btn + 'background:#fff;color:#374151;border:1px solid #E5E7EB;">' + escape(cancelText) + '</button>'
                + '<button type="button" data-act="ok" style="' + btn + 'color:#fff;background:' + okBg + ';">' + escape(okText) + '</button>'
                + '</div></div>';
            document.body.appendChild(overlay);
            overlay.style.display = 'flex';
            function close(val) {
                if (overlay.parentElement) overlay.remove();
                document.removeEventListener('keydown', onKey);
                resolve(val);
            }
            function onKey(e) { if (e.key === 'Escape') close(false); }
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) { close(false); return; }
                var act = e.target.getAttribute('data-act');
                if (act === 'ok') close(true); else if (act === 'cancel') close(false);
            });
            document.addEventListener('keydown', onKey);
        });
    }

    // ---------------- 自定义输入弹窗（替代原生 prompt，Promise<string|null>） ----------------
    // 用法：App.prompt({ title:'驳回原因', placeholder:'请输入驳回原因：', okText:'确认驳回' }).then(function(val){ if(val===null) return; ... });
    // resolve：确认时返回去掉首尾空格的字符串（required 下空值不允许关闭）；取消/遮罩/Esc 返回 null。
    function promptDialog(options) {
        options = options || {};
        var required = options.required !== false; // 默认必须有非空输入
        return new Promise(function (resolve) {
            var overlay = document.createElement('div');
            overlay.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10000;align-items:center;justify-content:center;';
            var title = options.title || '请输入';
            var okText = options.okText || '确认';
            var cancelText = options.cancelText || '取消';
            var placeholder = options.placeholder || '';
            var defVal = options.defaultValue || '';
            var okBg = options.danger ? '#EF4444' : '#2563EB';
            var btn = 'padding:8px 18px;border-radius:6px;font-size:13px;cursor:pointer;border:none;';
            overlay.innerHTML = '<div style="background:#fff;border-radius:12px;width:440px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,.2);">'
                + '<div style="padding:18px 24px;border-bottom:1px solid #E5E7EB;font-size:16px;font-weight:600;color:#1E3A5F;">' + escape(title) + '</div>'
                + '<div style="padding:22px 24px;">'
                + (options.message ? '<div style="font-size:13px;color:#6B7280;margin-bottom:10px;line-height:1.6;">' + escape(options.message) + '</div>' : '')
                + '<textarea data-role="input" rows="4" style="width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #E5E7EB;border-radius:8px;font-size:14px;resize:vertical;font-family:inherit;color:#111827;" placeholder="' + escape(placeholder) + '">' + escape(defVal) + '</textarea>'
                + '<div data-role="err" style="display:none;color:#EF4444;font-size:12px;margin-top:8px;">' + escape(options.emptyText || '内容不能为空') + '</div>'
                + '</div>'
                + '<div style="padding:16px 24px;border-top:1px solid #E5E7EB;display:flex;justify-content:flex-end;gap:12px;">'
                + '<button type="button" data-act="cancel" style="' + btn + 'background:#fff;color:#374151;border:1px solid #E5E7EB;">' + escape(cancelText) + '</button>'
                + '<button type="button" data-act="ok" style="' + btn + 'color:#fff;background:' + okBg + ';">' + escape(okText) + '</button>'
                + '</div></div>';
            document.body.appendChild(overlay);
            overlay.style.display = 'flex';
            var input = overlay.querySelector('[data-role="input"]');
            var errEl = overlay.querySelector('[data-role="err"]');
            setTimeout(function () { if (input) input.focus(); }, 30);
            function close(val) {
                if (overlay.parentElement) overlay.remove();
                document.removeEventListener('keydown', onKey);
                resolve(val);
            }
            function submit() {
                var v = (input.value || '').trim();
                if (required && v === '') { if (errEl) errEl.style.display = 'block'; if (input) input.focus(); return; }
                close(v);
            }
            function onKey(e) {
                if (e.key === 'Escape') { close(null); return; }
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { submit(); }
            }
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) { close(null); return; }
                var act = e.target.getAttribute('data-act');
                if (act === 'ok') submit(); else if (act === 'cancel') close(null);
            });
            if (input) input.addEventListener('input', function () { if (errEl) errEl.style.display = 'none'; });
            document.addEventListener('keydown', onKey);
        });
    }

    // ---------------- HTML 转义（XSS 防护） ----------------
    // 将任意值转为可安全插入 innerHTML 的文本；null/undefined 返回空串。
    function escape(s) {
        if (s === null || s === undefined) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ---------------- 查询串 ----------------
    function buildQuery(params) {
        if (!params) return '';
        var parts = [];
        Object.keys(params).forEach(function (k) {
            var v = params[k];
            if (v === undefined || v === null || v === '') return;
            parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
        });
        return parts.join('&');
    }

    // ---------------- 统一请求 ----------------
    // options: { method, body(对象或字符串), headers, silent(不弹错误) }
    // 成功返回 data；失败 reject（并按需 Toast、401 跳转）
    function apiFetch(path, options) {
        options = options || {};
        var version = sessionVersion;
        var opts = { method: options.method || 'GET', headers: {}, cache: 'no-store' };

        if (options.body !== undefined && options.body !== null) {
            if (typeof options.body === 'string' || options.body instanceof FormData) {
                opts.body = options.body;
                if (!(options.body instanceof FormData)) opts.headers['Content-Type'] = 'application/json';
            } else {
                opts.headers['Content-Type'] = 'application/json';
                opts.body = JSON.stringify(options.body);
            }
        }
        var t = getToken();
        if (t) opts.headers['Authorization'] = 'Bearer ' + t;
        if (options.headers) {
            Object.keys(options.headers).forEach(function (k) { opts.headers[k] = options.headers[k]; });
        }

        var url = (path.indexOf('http') === 0 || path.indexOf('/api') === 0) ? path : (API_PREFIX + path);

        return fetch(url, opts).then(function (resp) {
            if (version !== sessionVersion || t !== getToken()) return Promise.reject({ message: '登录身份已变化，请重新打开页面' });
            if (resp.status === 401) {
                redirectToLogin();
                return Promise.reject({ code: 401, message: '未登录或登录已过期' });
            }
            return resp.json().catch(function () {
                return { code: resp.status, message: '服务异常(' + resp.status + ')' };
            }).then(function (json) {
                if (version !== sessionVersion || t !== getToken()) return Promise.reject({ message: '旧会话响应已丢弃' });
                if (json && json.code === 401) redirectToLogin();
                if (json && json.code === 200) return json.data;
                var msg = (json && json.message) || ('请求失败(' + resp.status + ')');
                if (!options.silent) toast(msg, 'error');
                return Promise.reject(json || { code: resp.status, message: msg });
            });
        }, function (err) {
            if (!options.silent) toast('网络错误，请检查连接', 'error');
            return Promise.reject(err || { code: -1, message: '网络错误' });
        });
    }

    // ---------------- 表格占位（防“数据闪烁”） ----------------
    // 页面模板不允许写任何示例数据行；表格首屏只显示“数据加载中”，
    // 拿到接口结果后再渲染真实数据，空数据显示“暂无数据”占位。
    var LOADING_HTML = '数据加载中...';
    var EMPTY_HTML = '暂无数据';
    function placeholderRow(colspan, text) {
        var n = Number(colspan) > 0 ? Number(colspan) : 1;
        return '<tr data-app-placeholder="1"><td colspan="' + n + '" style="text-align:center;color:#9CA3AF;padding:40px;">'
            + escape(text) + '</td></tr>';
    }
    function tableLoading(tbody, colspan) {
        if (!tbody) return;
        tbody.innerHTML = placeholderRow(colspan, LOADING_HTML);
    }
    function tableEmpty(tbody, colspan, text) {
        if (!tbody) return;
        tbody.innerHTML = placeholderRow(colspan, text || EMPTY_HTML);
    }
    // 并发请求序号：只允许最后一次查询写入界面，避免旧响应覆盖新结果
    function sequenceGuard() {
        var latest = 0;
        return function () {
            var seq = ++latest;
            return function () { return seq === latest; };
        };
    }

    // 分页查询：统一返回 { list, total, pageNum, pageSize }
    function apiGetPage(path, params) {
        var qs = buildQuery(params);
        return apiFetch(path + (qs ? ('?' + qs) : ''), { method: 'GET' }).then(function (data) {
            data = data || {};
            return {
                list: data.list || [],
                total: data.total || 0,
                pageNum: data.pageNum || (params && params.pageNum) || 1,
                pageSize: data.pageSize || (params && params.pageSize) || 10
            };
        });
    }

    // 文件上传：字段名 file，返回后端 data（通常为可访问 URL 或文件信息）
    function uploadFile(file, fieldName) {
        var fd = new FormData();
        fd.append(fieldName || 'file', file);
        return apiFetch('/files/upload', { method: 'POST', body: fd });
    }

    // 原始附件标识保留在 data-url 中，展示和下载时才换取短时链接。
    function uploadedPath(value) {
        if (!value) return null;
        var normalized = value.replace(/\\/g, '/');
        if (normalized.indexOf('uploads/') === 0) normalized = '/api/' + normalized;
        if (normalized.indexOf('/uploads/') === 0) normalized = '/api' + normalized;
        return /^\/api\/uploads\/(?:[0-9]{8}\/)?[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(normalized) ? normalized : null;
    }
    function fileUrl(value) { return apiFetch('/files/access?' + buildQuery({ url: value }), { silent: true }).then(function (link) { return link.url; }); }

    // ---------------- 认证文件下载 ----------------
    // 导出 Word / Excel 等二进制响应统一走此处：带 Bearer 令牌，
    // 文件名优先取响应头 filename*=UTF-8''（中文），回退到调用方给的默认名。
    function fileNameFromHeader(value) {
        if (!value) return '';
        var extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(value);
        if (extended) {
            try { return decodeURIComponent(extended[1].trim()); } catch (e) { return extended[1].trim(); }
        }
        var plain = /filename\s*=\s*"?([^";]+)"?/i.exec(value);
        return plain ? plain[1].trim() : '';
    }
    function downloadFile(path, fallbackName) {
        var token = getToken();
        var url = (path.indexOf('http') === 0 || path.indexOf('/api') === 0) ? path : (API_PREFIX + path);
        var headers = {};
        if (token) headers['Authorization'] = 'Bearer ' + token;
        return fetch(url, { method: 'GET', headers: headers, cache: 'no-store' }).then(function (resp) {
            if (resp.status === 401) {
                redirectToLogin();
                return Promise.reject({ code: 401, message: '未登录或登录已过期' });
            }
            if (!resp.ok) {
                // 导出失败时后端返回 ApiResponse JSON，解析出可读提示而非把错误当文件保存
                return resp.json().catch(function () { return null; }).then(function (json) {
                    var msg = (json && json.message) || ('导出失败（' + resp.status + '）');
                    toast(msg, 'error');
                    return Promise.reject(json || { code: resp.status, message: msg });
                });
            }
            var name = fileNameFromHeader(resp.headers.get('Content-Disposition')) || fallbackName || '导出文件';
            return resp.blob().then(function (blob) {
                var objectUrl = URL.createObjectURL(blob);
                var link = document.createElement('a');
                link.href = objectUrl;
                link.download = name;
                link.style.display = 'none';
                document.body.appendChild(link);
                link.click();
                setTimeout(function () {
                    if (link.parentNode) link.parentNode.removeChild(link);
                    URL.revokeObjectURL(objectUrl);
                }, 1000);
                return name;
            });
        }, function (err) {
            toast('网络错误，请检查连接', 'error');
            return Promise.reject(err || { code: -1, message: '网络错误' });
        });
    }
    function protectImages(node, refresh) {
        if (!node || node.nodeType !== 1) return;
        var images = node.matches('img') ? [node] : Array.from(node.querySelectorAll('img'));
        images.forEach(function (image) {
            var raw = uploadedPath(image.getAttribute('src')) || (refresh === true && image.dataset.fileOriginal);
            if (!raw || image.dataset.fileLoading === raw || !getToken()) return;
            image.dataset.fileLoading = raw;
            image.dataset.fileOriginal = raw;
            fileUrl(raw).then(function (url) {
                if (image.dataset.fileOriginal === raw) { image.src = url; image.classList.remove('error'); }
            }).catch(function (e) { image.alt = e.message || '附件获取失败，点击重试'; }).finally(function () { delete image.dataset.fileLoading; });
        });
    }
    function initProtectedFiles() {
        protectImages(document.body);
        new MutationObserver(function (changes) {
            changes.forEach(function (change) { if (change.type === 'attributes') protectImages(change.target); else change.addedNodes.forEach(protectImages); });
        }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
        document.addEventListener('click', function (event) {
            var link = event.target.closest('a[href]');
            var raw = link && uploadedPath(link.getAttribute('href'));
            if (raw) {
                event.preventDefault(); event.stopImmediatePropagation();
                var target = window.open('about:blank', '_blank'); if (target) target.opener = null;
                fileUrl(raw).then(function (url) { if (target) target.location = url; else toast('请允许弹出附件窗口后重试'); })
                    .catch(function (e) { if (target) target.close(); toast(e.message, 'error'); });
            } else if (event.target.matches('img[data-file-original]')) protectImages(event.target, true);
        }, true);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initProtectedFiles); else initProtectedFiles();

    // ---------------- 顶栏初始化（可选） ----------------
    // 更新用户名/头像首字母，拉取未读消息数写入 #notifBadge，绑定退出登录。
    function renderIdentity() {
        var user = getUser();
        var name = user.userName || '用户';
        var initial = name.charAt(0) || 'U';

        document.querySelectorAll('.user-name, .up-name').forEach(function (el) { el.textContent = name; });
        document.querySelectorAll('.user-avatar, .up-avatar, #headerAvatar, #panelAvatar').forEach(function (el) {
            if (user.avatar) {
                el.innerHTML = '<img src="' + escape(user.avatar) + '" alt="' + escape(name) + '">';
            } else {
                el.textContent = initial;
            }
        });

        document.querySelectorAll('.up-role').forEach(function (el) {
            el.textContent = user.roles.indexOf('admin') >= 0 ? '系统管理员' : '当前登录用户';
        });
        var settingName = document.getElementById('settingName');
        if (settingName) settingName.value = name;
    }

    // ---------------- 统一用户下拉菜单 ----------------
    // 顶栏头像/姓名展开下拉菜单：个人资料、修改密码、操作日志、退出登录（二次确认）。
    // 样式与图标（内联 SVG）由本文件注入，24 个业务页零改动继承；已内置个人面板的页面只补齐缺失项。
    var CHEVRON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    var MENU_ICONS = {
        profile: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/></svg>',
        password: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2"/><path d="M16.5 7.5l3 3"/></svg>',
        log: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h6"/></svg>',
        logout: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>'
    };
    var chromeInjected = false;
    function injectChromeCss() {
        if (chromeInjected) return;
        if (document.getElementById('appChromeStyle')) { chromeInjected = true; return; }
        var style = document.createElement('style');
        style.id = 'appChromeStyle';
        style.textContent = [
            '.app-caret{display:inline-flex;align-items:center;color:#9CA3AF;transition:transform .2s,color .15s;}',
            '.user-info:hover .app-caret{color:#2563EB;}',
            '.app-user-menu{position:absolute;top:calc(100% + 12px);right:0;min-width:192px;background:#fff;border:1px solid #E5E7EB;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,0.12);padding:6px;z-index:300;}',
            '.app-user-menu.open{animation:appMenuIn .18s ease;}',
            '@keyframes appMenuIn{from{opacity:0;transform:translateY(-6px);}to{opacity:1;transform:none;}}',
            '.app-menu-head{padding:10px 12px 8px;border-bottom:1px solid #F3F4F6;margin-bottom:4px;}',
            '.app-menu-head-name{display:block;font-size:14px;font-weight:600;color:#1E3A5F;}',
            '.app-menu-head-sub{display:block;font-size:11px;color:#9CA3AF;margin-top:2px;}',
            '.app-menu-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;font-size:13px;color:#374151;cursor:pointer;transition:background .15s,color .15s;}',
            '.app-menu-item:hover{background:#F0F5FF;color:#1E3A5F;}',
            '.app-menu-item:active{background:#DBEAFE;}',
            '.app-menu-item .ico{width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;color:#6B7280;flex-shrink:0;}',
            '.app-menu-item:hover .ico{color:#2563EB;}',
            '.app-menu-divider{height:1px;background:#F3F4F6;margin:6px 4px;}',
            '.app-menu-item.danger{color:#EF4444;}',
            '.app-menu-item.danger:hover{background:#FEF2F2;color:#EF4444;}',
            '.app-menu-item.danger .ico{color:#EF4444;}',
            '.app-modal-overlay{display:flex;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;align-items:center;justify-content:center;animation:appModalIn .2s ease;}',
            '@keyframes appModalIn{from{opacity:0;}to{opacity:1;}}',
            '.app-modal{background:#fff;border-radius:16px;width:400px;max-width:92vw;overflow:hidden;}',
            '.app-modal-head{padding:16px 20px;border-bottom:1px solid #F3F4F6;display:flex;align-items:center;justify-content:space-between;font-size:16px;font-weight:600;color:#1E3A5F;}',
            '.app-modal-close{width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:15px;color:#6B7280;border:none;background:none;}',
            '.app-modal-close:hover{background:#F3F4F6;color:#374151;}',
            '.app-modal-body{padding:20px;}',
            '.app-modal-err{display:none;background:#FEF2F2;color:#EF4444;font-size:12px;padding:8px 12px;border-radius:8px;margin-bottom:14px;}',
            '.app-field{margin-bottom:14px;}',
            '.app-field label{display:block;font-size:12px;color:#6B7280;margin-bottom:6px;}',
            '.app-field input{width:100%;padding:9px 12px;border:1px solid #E5E7EB;border-radius:8px;font-size:14px;font-family:inherit;color:#111827;outline:none;transition:border-color .15s,box-shadow .15s;}',
            '.app-field input:focus{border-color:#2563EB;box-shadow:0 0 0 3px rgba(37,99,235,0.12);}',
            '.app-modal-foot{padding:14px 20px;border-top:1px solid #F3F4F6;display:flex;justify-content:flex-end;gap:10px;}',
            '.app-btn{padding:8px 18px;border-radius:8px;font-size:13px;cursor:pointer;border:none;font-family:inherit;}',
            '.app-btn-primary{background:#2563EB;color:#fff;}',
            '.app-btn-primary:hover{background:#1D4ED8;}',
            '.app-btn-ghost{background:#fff;color:#374151;border:1px solid #E5E7EB;}',
            '.app-btn-ghost:hover{background:#F8FAFC;}',
            '.app-profile-row{display:flex;justify-content:space-between;align-items:center;padding:10px 2px;border-bottom:1px solid #F9FAFB;font-size:13px;}',
            '@media (max-width:768px){.app-user-menu{right:-36px;}}'
        ].join('\n');
        (document.head || document.documentElement).appendChild(style);
        chromeInjected = true;
    }

    function closeUserMenu() {
        var panel = document.getElementById('appUserMenu');
        if (panel) { panel.className = 'app-user-menu'; panel.style.display = 'none'; }
        var caret = document.getElementById('appUserCaret');
        if (caret) caret.style.transform = '';
    }
    function toggleUserMenu(force) {
        var panel = document.getElementById('appUserMenu');
        if (!panel) return;
        var open = force === true ? true : (force === false ? false : panel.style.display !== 'block');
        panel.style.display = open ? 'block' : 'none';
        panel.className = 'app-user-menu' + (open ? ' open' : '');
        var caret = document.getElementById('appUserCaret');
        if (caret) caret.style.transform = open ? 'rotate(180deg)' : '';
    }

    function menuI(id, icon, label, cls, handler) {
        var item = document.createElement('div');
        item.id = id;
        item.className = cls || 'app-menu-item';
        item.innerHTML = '<span class="ico">' + icon + '</span><span>' + escape(label) + '</span>';
        item.addEventListener('click', function (event) { event.stopPropagation(); handler(); });
        return item;
    }

    // 退出前二次确认，防止误操作；确认后沿用既有 logout（立即清理 + 后端撤销）。
    function confirmLogout() {
        closeUserMenu();
        confirmDialog('退出后需重新登录才能使用，本页尚未提交的草稿会被清除。确定退出登录吗？', {
            title: '退出登录', okText: '退出登录', cancelText: '再想想', icon: '🚪'
        }).then(function (ok) { if (ok) logout(); });
    }

    function bindModalClose(overlay) {
        function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
        overlay.addEventListener('click', function (event) {
            if (event.target === overlay) { close(); return; }
            if (event.target.getAttribute && event.target.getAttribute('data-act') === 'close') close();
        });
        function onKey(event) { if (event.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } }
        document.addEventListener('keydown', onKey);
    }

    function openProfileModal() {
        if (document.getElementById('appProfileModal')) return;
        var user = getUser();
        var roleText = (user.roles || []).indexOf('admin') >= 0 ? '系统管理员' : '现场监理人员';
        var overlay = document.createElement('div');
        overlay.id = 'appProfileModal';
        overlay.className = 'app-modal-overlay';
        overlay.innerHTML = '<div class="app-modal">'
            + '<div class="app-modal-head"><span>个人资料</span><button type="button" class="app-modal-close" data-act="close" aria-label="关闭">✕</button></div>'
            + '<div class="app-modal-body">'
            + '<div class="app-profile-row"><span style="color:#6B7280;">姓名</span><span style="font-weight:600;color:#1F2937;">' + escape(user.userName || '—') + '</span></div>'
            + '<div class="app-profile-row"><span style="color:#6B7280;">角色</span><span style="font-weight:600;color:#1F2937;">' + escape(roleText) + '</span></div>'
            + '<div class="app-profile-row"><span style="color:#6B7280;">账号 ID</span><span style="font-weight:600;color:#1F2937;">' + escape(user.userId || '—') + '</span></div>'
            + '<div style="font-size:12px;color:#9CA3AF;margin-top:12px;">身份数据以服务端当前状态为准；如需调整头像等偏好，请从个人设置入口操作。</div>'
            + '</div>'
            + '<div class="app-modal-foot"><button type="button" class="app-btn app-btn-primary" data-act="close">关闭</button></div>'
            + '</div>';
        document.body.appendChild(overlay);
        bindModalClose(overlay);
    }

    // 自助改密：走全体登录用户可用的 /auth/change-password（校验原密码）；
    // /users/{id}/reset-password 是管理员重置他人密码的接口（普通用户 403），不适合自助修改。
    function openPwdModal() {
        closeUserMenu();
        if (document.getElementById('appPwdModal')) return;
        var overlay = document.createElement('div');
        overlay.id = 'appPwdModal';
        overlay.className = 'app-modal-overlay';
        overlay.innerHTML = '<div class="app-modal">'
            + '<div class="app-modal-head"><span>修改密码</span><button type="button" class="app-modal-close" data-act="close" aria-label="关闭">✕</button></div>'
            + '<div class="app-modal-body">'
            + '<div class="app-modal-err" id="appPwdErr"></div>'
            + '<div class="app-field"><label for="appOldPwd">原密码</label><input type="password" id="appOldPwd" autocomplete="current-password" placeholder="请输入当前密码"></div>'
            + '<div class="app-field"><label for="appNewPwd">新密码</label><input type="password" id="appNewPwd" autocomplete="new-password" placeholder="6-32 位新密码"></div>'
            + '<div class="app-field"><label for="appConfirmPwd">确认新密码</label><input type="password" id="appConfirmPwd" autocomplete="new-password" placeholder="再次输入新密码"></div>'
            + '</div>'
            + '<div class="app-modal-foot"><button type="button" class="app-btn app-btn-ghost" data-act="close">取消</button><button type="button" class="app-btn app-btn-primary" id="appPwdSubmit">确认修改</button></div>'
            + '</div>';
        document.body.appendChild(overlay);
        bindModalClose(overlay);
        var err = document.getElementById('appPwdErr');
        function showErr(msg) { if (err) { err.textContent = msg; err.style.display = 'block'; } }
        var submit = document.getElementById('appPwdSubmit');
        if (submit) submit.addEventListener('click', function () {
            var oldPwd = (document.getElementById('appOldPwd').value || '').trim();
            var newPwd = (document.getElementById('appNewPwd').value || '').trim();
            var confirmPwd = (document.getElementById('appConfirmPwd').value || '').trim();
            if (!oldPwd) { showErr('请输入原密码'); return; }
            if (newPwd.length < 6 || newPwd.length > 32) { showErr('新密码长度应为 6-32 位'); return; }
            if (newPwd === oldPwd) { showErr('新密码不能与原密码相同'); return; }
            if (newPwd !== confirmPwd) { showErr('两次输入的新密码不一致'); return; }
            submit.disabled = true;
            apiFetch('/auth/change-password', { method: 'POST', body: { oldPassword: oldPwd, newPassword: newPwd }, silent: true }).then(function () {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                toast('密码修改成功', 'success');
            }).catch(function (e) {
                submit.disabled = false;
                showErr((e && e.message) || '密码修改失败，请稍后重试');
            });
        });
        var first = document.getElementById('appOldPwd');
        if (first) setTimeout(function () { first.focus(); }, 60);
    }

    // 页面自带个人面板（仅 index.html）：在其菜单内补齐修改密码与操作日志，并为退出加二次确认。
    function enhanceNativeMenu(nativeMenu) {
        if (document.getElementById('appMenuPwd')) return;
        var divider = nativeMenu.querySelector('.up-menu-divider') || null;
        var pwd = document.createElement('div');
        pwd.id = 'appMenuPwd';
        pwd.className = 'up-menu-item';
        pwd.innerHTML = '<span class="up-menu-icon">🔑</span>修改密码';
        pwd.addEventListener('click', function (event) { event.stopPropagation(); openPwdModal(); });
        var log = document.createElement('div');
        log.id = 'appMenuLog';
        log.className = 'up-menu-item';
        log.innerHTML = '<span class="up-menu-icon">📜</span>操作日志';
        log.addEventListener('click', function (event) { event.stopPropagation(); location.href = 'operation-log.html'; });
        nativeMenu.insertBefore(pwd, divider);
        nativeMenu.insertBefore(log, divider);
        var danger = nativeMenu.querySelector('.up-menu-item.danger');
        if (danger) danger.onclick = function (event) { event.stopPropagation(); confirmLogout(); };
    }

    function initUserMenu() {
        var nativeMenu = document.querySelector('.up-menu');
        if (nativeMenu) { enhanceNativeMenu(nativeMenu); return; }
        if (document.getElementById('appUserMenu')) return;
        injectChromeCss();
        var info = document.querySelector('.user-info');
        if (!info) {
            var right = document.querySelector('.header-right');
            if (!right) return;
            info = document.createElement('div');
            info.className = 'user-info';
            var avatar = document.createElement('div');
            avatar.className = 'user-avatar';
            info.appendChild(avatar);
            var name = document.createElement('span');
            name.className = 'user-name';
            info.appendChild(name);
            right.appendChild(info);
        }
        if (!document.getElementById('appUserCaret')) {
            var caret = document.createElement('span');
            caret.id = 'appUserCaret';
            caret.className = 'app-caret';
            caret.innerHTML = CHEVRON_SVG;
            info.appendChild(caret);
        }
        var panel = document.createElement('div');
        panel.id = 'appUserMenu';
        panel.className = 'app-user-menu';
        panel.style.display = 'none';
        var head = document.createElement('div');
        head.className = 'app-menu-head';
        head.innerHTML = '<span class="app-menu-head-name">' + escape(getUser().userName || '用户') + '</span><span class="app-menu-head-sub">欢迎回到工作台</span>';
        panel.appendChild(head);
        panel.appendChild(menuI('appMenuProfile', MENU_ICONS.profile, '个人资料', '', function () {
            closeUserMenu();
            if (typeof global.openSettingsModal === 'function') global.openSettingsModal();
            else openProfileModal();
        }));
        panel.appendChild(menuI('appMenuPwd', MENU_ICONS.password, '修改密码', '', openPwdModal));
        panel.appendChild(menuI('appMenuLog', MENU_ICONS.log, '操作日志', '', function () { location.href = 'operation-log.html'; }));
        var divider = document.createElement('div');
        divider.className = 'app-menu-divider';
        panel.appendChild(divider);
        panel.appendChild(menuI('appLogout', MENU_ICONS.logout, '退出登录', 'app-menu-item danger', confirmLogout));
        info.appendChild(panel);
        info.onclick = function (event) { event.stopPropagation(); toggleUserMenu(); };
        // 悬停展开＋点击切换双模式，离开 300ms 宽限收起，避免斜向移动丢失悬停。
        var enterTimer = null, leaveTimer = null;
        info.addEventListener('mouseenter', function () {
            if (!('ontouchstart' in global)) {
                clearTimeout(leaveTimer);
                enterTimer = setTimeout(function () { toggleUserMenu(true); }, 120);
            }
        });
        info.addEventListener('mouseleave', function () {
            clearTimeout(enterTimer);
            leaveTimer = setTimeout(closeUserMenu, 300);
        });
        document.addEventListener('click', closeUserMenu);
        document.addEventListener('keydown', function (event) { if (event.key === 'Escape') closeUserMenu(); });
    }

    function initTopbar() {
        if (!requireAuth()) return Promise.resolve();
        renderIdentity();
        // 统一的下拉用户菜单；页面自带个人面板时仅补齐缺失菜单项，不重复注入。
        initUserMenu();
        var right = document.querySelector('.header-right');
        if (right && !document.querySelector('.up-menu') && !document.getElementById('appUserMenu')) {
            var button = document.createElement('button');
            button.id = 'appLogout';
            button.type = 'button';
            button.className = 'btn btn-outline btn-sm';
            button.textContent = '退出登录';
            button.addEventListener('click', function (event) { event.stopPropagation(); logout(); });
            right.appendChild(button);
        }
        if (!identityRequest) {
            var version = sessionVersion;
            var token = getToken();
            identityRequest = apiFetch('/auth/info', { silent: true }).then(function (info) {
                if (version !== sessionVersion || token !== getToken()) return;
                saveSession(info);
                renderIdentity();
                document.documentElement.style.visibility = '';
                refreshUnreadBadge();
            }).catch(function () {
                if (version === sessionVersion && token === getToken()) redirectToLogin();
            });
        }
        return identityRequest;
    }

    function initSessionPage() {
        if (isLoginPage() || /welcome\.html$/i.test(location.pathname)) return;
        document.querySelectorAll('a[target="_blank"]').forEach(function (a) { a.rel = 'noopener noreferrer'; });
        initTopbar();
    }
    // 在绘制业务页前遮蔽模板用户信息，直链、刷新、浏览器后退均重新校验身份。
    if (global.location && !isLoginPage() && !/welcome\.html$/i.test(location.pathname)) {
        document.documentElement.style.visibility = 'hidden';
        requireAuth();
    }
    if (global.addEventListener) {
        global.addEventListener('storage', function (event) {
            var id = tokenId(readSession().token || '');
            if (id && event.key === LOGOUT_PREFIX + id && event.newValue) redirectToLogin();
        });
        global.addEventListener('pagehide', function () {
            if (!isLoginPage() && !/welcome\.html$/i.test(location.pathname)) document.documentElement.style.visibility = 'hidden';
        });
        global.addEventListener('pageshow', function (event) {
            if (event.persisted) { identityRequest = null; initSessionPage(); }
        });
        global.addEventListener('focus', function () {
            if (!isLoginPage() && !/welcome\.html$/i.test(location.pathname)) {
                identityRequest = null;
                initSessionPage();
            }
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSessionPage);
    else initSessionPage();

    function refreshUnreadBadge() {
        var user = getUser();
        if (!user.userId) return;
        apiFetch('/messages/unread-count?receiverId=' + encodeURIComponent(user.userId), { silent: true })
            .then(function (count) {
                var badge = document.getElementById('notifBadge');
                if (!badge) return;
                var n = Number(count) || 0;
                if (n > 0) { badge.textContent = n > 99 ? '99+' : n; badge.style.display = 'flex'; }
                else { badge.style.display = 'none'; }
            }).catch(function () { });
    }

    // ---------------- 移动菜单（汉堡按钮 + 侧边抽屉） ----------------
    // 作用范围:仅当页面同时存在 .sidebar 与 .header-left 时生效(=除 welcome.html 外的 24 个业务页)。
    // login.html 不会命中(无 sidebar/header-left),自然跳过。
    // 安全保护:
    //   1) try/catch 包裹,避免移动端 DOM 异常拖跨其他初始化逻辑
    //   2) 检测重复注入(window.__mobileMenuInited 标记)
    //   3) resize 跨越断点(768)时自动关闭抽屉,防止窗口变宽后遮罩层错乱
    function initMobileMenu() {
        try {
            // 防重复注入(避免某些页面多次 include app.js 时出现双套按钮)
            if (window.__mobileMenuInited) return;
            var sidebar = document.querySelector('.sidebar');
            var headerLeft = document.querySelector('.header-left');
            if (!sidebar || !headerLeft) return; // login.html / welcome.html 不走这里
            window.__mobileMenuInited = true;

            // 注入汉堡按钮
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'mobile-menu-btn';
            btn.setAttribute('aria-label', '打开菜单');
            btn.setAttribute('aria-controls', 'sidebarMenu');
            btn.setAttribute('aria-expanded', 'false');
            btn.innerHTML = '<span class="hamburger-icon" aria-hidden="true">☰</span>';
            // sidebar 加 id 供 aria-controls 引用
            if (!sidebar.id) sidebar.id = 'sidebarMenu';
            headerLeft.insertBefore(btn, headerLeft.firstChild);

            // 注入遮罩
            var backdrop = document.createElement('div');
            backdrop.className = 'sidebar-backdrop';
            backdrop.setAttribute('aria-hidden', 'true');
            document.body.appendChild(backdrop);

            function isOpen() { return sidebar.classList.contains('mobile-open'); }
            function toggleMenu(open) {
                sidebar.classList.toggle('mobile-open', open);
                backdrop.classList.toggle('show', open);
                btn.setAttribute('aria-expanded', open ? 'true' : 'false');
                btn.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
                document.body.style.overflow = open ? 'hidden' : '';
            }

            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                toggleMenu(!isOpen());
            });
            backdrop.addEventListener('click', function () { toggleMenu(false); });

            // Esc 键快捷关闭
            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape' && isOpen()) toggleMenu(false);
            });

            // 侧边栏内菜单项点击后自动收起
            sidebar.querySelectorAll('.menu-item').forEach(function (link) {
                link.addEventListener('click', function () {
                    if (window.innerWidth <= 768) toggleMenu(false);
                });
            });

            // 窗口 resize 跳过了 768 断点时,自动重置状态
            // (防止用户从手机旋转到平板/桌面后抽屉锁在打开状态且遮罩层错乱)
            var lastMobileState = window.innerWidth <= 768;
            window.addEventListener('resize', function () {
                var nowMobile = window.innerWidth <= 768;
                if (lastMobileState && !nowMobile && isOpen()) {
                    toggleMenu(false);
                }
                lastMobileState = nowMobile;
            });
        } catch (err) {
            // 安全降级:移动菜单初始化失败不影响其他业务逻辑
            if (window.console && console.warn) console.warn('[App] initMobileMenu 异常:', err);
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMobileMenu);
    } else {
        // 脚本在 <head> 中加载且未使用 defer/async 时,DOM 还未就绪
        // 这里走 DOMContentLoaded 分支;DOMContentLoaded 已发生后同步调用
        initMobileMenu();
    }

    // ---------------- 导出 ----------------
    global.App = {
        API_PREFIX: API_PREFIX,
        getToken: getToken,
        getUser: getUser,
        saveSession: saveSession,
        clearSession: clearSession,
        requireAuth: requireAuth,
        redirectToLogin: redirectToLogin,
        logout: logout,
        toast: toast,
        confirm: confirmDialog,
        prompt: promptDialog,
        escape: escape,
        buildQuery: buildQuery,
        tableLoading: tableLoading,
        tableEmpty: tableEmpty,
        placeholderRow: placeholderRow,
        sequenceGuard: sequenceGuard,
        apiFetch: apiFetch,
        apiGetPage: apiGetPage,
        uploadFile: uploadFile,
        fileUrl: fileUrl,
        downloadFile: downloadFile,
        initTopbar: initTopbar,
        refreshUnreadBadge: refreshUnreadBadge
    };

    // 便捷全局别名
    global.apiFetch = apiFetch;
    global.apiGetPage = apiGetPage;
    // 将原生 alert 代理为非阻断 Toast，统一全站提示风格（保留 __nativeAlert 以便特殊场景回退）
    global.__nativeAlert = global.alert;
    global.alert = function (msg) { toast(String(msg == null ? '' : msg), 'info'); };

})(window);
