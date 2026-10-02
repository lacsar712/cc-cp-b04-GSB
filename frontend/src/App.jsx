import { useCallback, useEffect, useState } from "preact/hooks";

const TOKEN_KEY = "coldchain_token";
const USER_KEY = "coldchain_user";

function verdictClass(v, status) {
  if (v === "合格") return "tag pass";
  if (v === "超温") return "tag fail";
  if (status === "pending" || status === "processing") return "tag wait";
  return "tag wait";
}

function displayVerdict(row) {
  if (row.verdict) return row.verdict;
  if (row.status === "pending") return "待处理";
  if (row.status === "processing") return "处理中";
  return "—";
}

function fmtTime(s) {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString("zh-CN", { hour12: false });
}

function AlertPage({ authHeaders, user }) {
  const isWriter = user?.role === "writer";
  const [rule, setRule] = useState(null);
  const [hits, setHits] = useState([]);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [saving, setSaving] = useState(false);

  const loadAll = useCallback(async () => {
    const [ruleRes, hitsRes, logsRes] = await Promise.all([
      fetch("/api/alert/rule", { headers: authHeaders() }),
      fetch("/api/alert/hits", { headers: authHeaders() }),
      fetch("/api/alert/push-logs", { headers: authHeaders() }),
    ]);
    if (!ruleRes.ok || !hitsRes.ok || !logsRes.ok) {
      setError("加载订阅铃数据失败，请重新登录");
      return;
    }
    // 三份数据均由服务端给出，前端只做展示，不做任何私下筛选。
    setRule(await ruleRes.json());
    setHits(await hitsRes.json());
    setLogs(await logsRes.json());
    setError("");
  }, [authHeaders]);

  useEffect(() => {
    loadAll();
    const t = setInterval(loadAll, 3000);
    return () => clearInterval(t);
  }, [loadAll]);

  async function toggleRule() {
    if (!isWriter || saving || !rule) return;
    setSaving(true);
    setError("");
    setMsg("");
    try {
      const res = await fetch("/api/alert/rule", {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ enabled: !rule.enabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.detail || "规则切换失败");
        return;
      }
      setRule(data);
      setMsg(
        data.enabled
          ? "规则已开启：此后新办结的超温单将进入命中列表并记推送流水"
          : "规则已关闭：立即停止新命中，已有命中与流水保留"
      );
      await loadAll();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div class="card">
        <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>超温订阅规则</h2>
        <div class="ruleline">
          <button
            type="button"
            class={rule?.enabled ? "switch on" : "switch"}
            disabled={!isWriter || saving || !rule}
            onClick={toggleRule}
            aria-pressed={rule?.enabled ? "true" : "false"}
            title={isWriter ? "点击切换规则" : "值班员只读，不能修改规则"}
          >
            <span class="knob" />
          </button>
          <div>
            <div class="rulestate">
              规则{rule?.enabled ? "已开启" : "已关闭"}
              {rule?.enabled && <span class="tag fail" style={{ marginLeft: "0.5rem" }}>订阅中</span>}
            </div>
            <div class="sub" style={{ margin: "0.25rem 0 0" }}>
              {isWriter
                ? "开启后，后台工人办结超温单时会把该单写入命中列表并同记一条推送流水；关闭后立即停止新命中，已有记录保留。"
                : "值班员仅可查看命中列表与推送流水，不能修改规则。"}
              {rule?.updated_by && (
                <span style={{ marginLeft: "0.5rem" }}>
                  最近由 {rule.updated_by} 于 {fmtTime(rule.updated_at)} 更新
                </span>
              )}
            </div>
          </div>
        </div>
        {error && <p class="err">{error}</p>}
        {msg && <p class="ok">{msg}</p>}
      </div>

      <div class="card">
        <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>
          命中列表<span class="count">（{hits.length}）</span>
        </h2>
        <table>
          <thead>
            <tr>
              <th>命中编号</th>
              <th>读数编号</th>
              <th>探头</th>
              <th>温度℃</th>
              <th>结论</th>
              <th>办结时间</th>
              <th>命中时间</th>
            </tr>
          </thead>
          <tbody>
            {hits.map((h) => (
              <tr key={h.id}>
                <td>{h.id}</td>
                <td>{h.reading_id}</td>
                <td>{h.probe_id}</td>
                <td>{h.temp_c}</td>
                <td><span class="tag fail">{h.verdict}</span></td>
                <td>{fmtTime(h.processed_at)}</td>
                <td>{fmtTime(h.matched_at)}</td>
              </tr>
            ))}
            {hits.length === 0 && (
              <tr>
                <td colspan="7">暂无命中（开启规则后办结的超温单才会进入此列表）</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>
          推送流水<span class="count">（{logs.length}）</span>
        </h2>
        <table>
          <thead>
            <tr>
              <th>流水编号</th>
              <th>命中编号</th>
              <th>读数编号</th>
              <th>探头</th>
              <th>温度℃</th>
              <th>推送渠道</th>
              <th>状态</th>
              <th>推送时间</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((p) => (
              <tr key={p.id}>
                <td>{p.id}</td>
                <td>{p.hit_id}</td>
                <td>{p.reading_id}</td>
                <td>{p.probe_id}</td>
                <td>{p.temp_c}</td>
                <td>{p.channel}</td>
                <td><span class="tag pass">{p.status}</span></td>
                <td>{fmtTime(p.pushed_at)}</td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr>
                <td colspan="8">暂无推送流水</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch {
      return null;
    }
  });
  const [view, setView] = useState(() => window.location.hash);
  const [loginForm, setLoginForm] = useState({ username: "logger", password: "log123456" });
  const [submitForm, setSubmitForm] = useState({ probe_id: "", temp_c: "" });
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const onHash = () => setView(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const isAlertView = view.startsWith("#/alert");

  const authHeaders = useCallback(() => {
    const h = { "Content-Type": "application/json" };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [token]);

  const loadReadings = useCallback(async () => {
    if (!token) return;
    const res = await fetch("/api/readings", { headers: authHeaders() });
    if (!res.ok) {
      setError("加载列表失败，请重新登录");
      return;
    }
    setRows(await res.json());
  }, [token, authHeaders]);

  useEffect(() => {
    loadReadings();
    if (!token) return undefined;
    const t = setInterval(loadReadings, 3000);
    return () => clearInterval(t);
  }, [loadReadings, token]);

  async function onLogin(e) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loginForm),
      });
      if (!res.ok) {
        setError("用户名或密码错误");
        return;
      }
      const data = await res.json();
      localStorage.setItem(TOKEN_KEY, data.access_token);
      localStorage.setItem(
        USER_KEY,
        JSON.stringify({ username: data.username, role: data.role })
      );
      setToken(data.access_token);
      setUser({ username: data.username, role: data.role });
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
    setRows([]);
    window.location.hash = "";
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setMsg("");
    setLoading(true);
    try {
      const res = await fetch("/api/readings", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          probe_id: submitForm.probe_id,
          temp_c: parseFloat(submitForm.temp_c),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.detail || "提交失败");
        return;
      }
      setMsg(data.message || "已提交");
      setSubmitForm({ probe_id: "", temp_c: "" });
      await loadReadings();
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div class="wrap">
        <h1>冷链探头超温台</h1>
        <p class="sub">记录员提交探头编号与摄氏温度，后台工人认领后判定合格或超温。</p>
        <div class="card">
          <form onSubmit={onLogin}>
            <div class="row">
              <label>
                用户名
                <input
                  value={loginForm.username}
                  onInput={(e) =>
                    setLoginForm({ ...loginForm, username: e.target.value })
                  }
                />
              </label>
              <label>
                密码
                <input
                  type="password"
                  value={loginForm.password}
                  onInput={(e) =>
                    setLoginForm({ ...loginForm, password: e.target.value })
                  }
                />
              </label>
              <button type="submit" disabled={loading}>
                登录
              </button>
            </div>
            {error && <p class="err">{error}</p>}
          </form>
          <p class="sub" style={{ marginBottom: 0 }}>
            记录员 logger / log123456 · 值班员 watcher / watch123456
          </p>
        </div>
      </div>
    );
  }

  const isWriter = user?.role === "writer";

  return (
    <div class="wrap">
      <div class="topbar">
        <div>
          <h1>冷链探头超温台</h1>
          <nav class="nav">
            <a href="#/" class={isAlertView ? "navlink" : "navlink active"}>
              读数台
            </a>
            <a href="#/alert" class={isAlertView ? "navlink active" : "navlink"}>
              🔔 订阅铃
            </a>
          </nav>
        </div>
        <div class="user">
          {user?.username}（{isWriter ? "记录员" : "值班员"}）
          <button type="button" class="secondary" style={{ marginLeft: "0.5rem" }} onClick={logout}>
            退出
          </button>
        </div>
      </div>

      {isAlertView ? (
        <AlertPage authHeaders={authHeaders} user={user} />
      ) : (
        <div>
          {isWriter && (
            <div class="card">
              <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>提交读数</h2>
              <form onSubmit={onSubmit}>
                <div class="row">
                  <label>
                    探头编号
                    <input
                      required
                      value={submitForm.probe_id}
                      onInput={(e) =>
                        setSubmitForm({ ...submitForm, probe_id: e.target.value })
                      }
                      placeholder="例如 探头C03"
                    />
                  </label>
                  <label>
                    温度（℃）
                    <input
                      required
                      type="number"
                      step="0.1"
                      value={submitForm.temp_c}
                      onInput={(e) =>
                        setSubmitForm({ ...submitForm, temp_c: e.target.value })
                      }
                    />
                  </label>
                  <button type="submit" disabled={loading}>
                    提交
                  </button>
                </div>
                {error && <p class="err">{error}</p>}
                {msg && <p class="ok">{msg}</p>}
              </form>
            </div>
          )}

          <div class="card">
            <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>读数列表</h2>
            <table>
              <thead>
                <tr>
                  <th>编号</th>
                  <th>探头</th>
                  <th>温度℃</th>
                  <th>结论</th>
                  <th>说明</th>
                  <th>状态</th>
                  <th>提交人</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.id}</td>
                    <td>{r.probe_id}</td>
                    <td>{r.temp_c}</td>
                    <td>
                      <span class={verdictClass(r.verdict, r.status)}>
                        {displayVerdict(r)}
                      </span>
                    </td>
                    <td>{r.reason || "—"}</td>
                    <td>{r.status}</td>
                    <td>{r.created_by}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colspan="7">暂无数据</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
