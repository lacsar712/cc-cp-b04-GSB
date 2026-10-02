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

function fmt(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
  const [view, setView] = useState("desk"); // desk | bell
  const [loginForm, setLoginForm] = useState({ username: "logger", password: "log123456" });
  const [submitForm, setSubmitForm] = useState({ probe_id: "", temp_c: "" });
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

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
    if (view !== "desk" || !token) return undefined;
    loadReadings();
    const t = setInterval(loadReadings, 3000);
    return () => clearInterval(t);
  }, [loadReadings, token, view]);

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
    setView("desk");
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
          <p class="sub" style={{ marginBottom: 0 }}>
            温度不超过 8℃ 为合格，否则为超温。
          </p>
        </div>
        <div class="user">
          <button
            type="button"
            class={view === "bell" ? "bell active" : "bell"}
            onClick={() => setView(view === "bell" ? "desk" : "bell")}
            title="异常超温订阅铃"
          >
            🔔 订阅铃
          </button>
          {user?.username}（{isWriter ? "记录员" : "值班员"}）
          <button type="button" class="secondary" style={{ marginLeft: "0.5rem" }} onClick={logout}>
            退出
          </button>
        </div>
      </div>

      {view === "bell" ? (
        <BellPage
          authHeaders={authHeaders}
          isWriter={isWriter}
          onAuthError={logout}
        />
      ) : (
        <DeskView
          rows={rows}
          isWriter={isWriter}
          loading={loading}
          error={error}
          msg={msg}
          submitForm={submitForm}
          setSubmitForm={setSubmitForm}
          onSubmit={onSubmit}
        />
      )}
    </div>
  );
}

function DeskView({ rows, isWriter, loading, error, msg, submitForm, setSubmitForm, onSubmit }) {
  return (
    <>
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
    </>
  );
}

function BellPage({ authHeaders, isWriter, onAuthError }) {
  const [setting, setSetting] = useState(null);
  const [hits, setHits] = useState([]);
  const [logs, setLogs] = useState([]);
  const [recon, setRecon] = useState(null);
  const [err, setErr] = useState("");
  const [switching, setSwitching] = useState(false);

  const load = useCallback(async () => {
    const opts = { headers: authHeaders() };
    const [s, h, l, r] = await Promise.all([
      fetch("/api/subscription", opts),
      fetch("/api/alert-hits", opts),
      fetch("/api/push-logs", opts),
      fetch("/api/subscription/reconcile", opts),
    ]);
    if ([s, h, l, r].some((x) => x.status === 401)) {
      onAuthError();
      return;
    }
    if (!s.ok || !h.ok || !l.ok || !r.ok) {
      setErr("加载订阅铃数据失败");
      return;
    }
    setErr("");
    setSetting(await s.json());
    setHits(await h.json());
    setLogs(await l.json());
    setRecon(await r.json());
  }, [authHeaders, onAuthError]);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  async function toggleRule(next) {
    if (!isWriter || switching) return;
    setErr("");
    setSwitching(true);
    try {
      const res = await fetch("/api/subscription", {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ enabled: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403) {
        setErr(data.detail || "值班员只读，不能修改规则");
        return;
      }
      if (!res.ok) {
        setErr(data.detail || "切换规则失败");
        return;
      }
      await load();
    } finally {
      setSwitching(false);
    }
  }

  const enabled = setting?.enabled ?? false;

  return (
    <>
      <div class="card">
        <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>订阅规则</h2>
        <div class="rule-row">
          <label class="switch">
            <input
              type="checkbox"
              checked={enabled}
              disabled={!isWriter || switching}
              onChange={(e) => toggleRule(e.target.checked)}
            />
            <span class="slider" />
          </label>
          <div>
            <strong>{enabled ? "规则已开启" : "规则已关闭"}</strong>
            <p class="sub" style={{ margin: "0.25rem 0 0" }}>
              开启后，服务端会把每一笔新办结的超温单写入命中列表并记一条推送流水；
              关闭后立刻停止新命中，已有命中与流水保留。
            </p>
            {!isWriter && (
              <p class="err" style={{ marginBottom: 0 }}>
                当前为值班员（只读）：可查看命中与流水，不能修改规则开关。
              </p>
            )}
            {setting?.updated_by && (
              <p class="sub" style={{ margin: "0.25rem 0 0", fontSize: "0.8rem" }}>
                最近由 {setting.updated_by} 于 {fmt(setting.updated_at)} 更新
              </p>
            )}
          </div>
        </div>
      </div>

      <div class="card">
        <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>服务端对账</h2>
        {recon ? (
          <div class={recon.consistent ? "recon ok-box" : "recon bad-box"}>
            {recon.consistent
              ? `对账一致：办结超温 ${recon.done_overtemp_count} 笔 · 命中 ${recon.hit_count} 行 · 推送流水 ${recon.push_count} 条（命中与流水一一对应）`
              : `对账异常：命中 ${recon.hit_count} 行但流水 ${recon.push_count} 条，有 ${recon.hits_without_push_count} 行命中缺流水`}
          </div>
        ) : (
          <p class="sub" style={{ margin: 0 }}>对账中…</p>
        )}
      </div>

      <div class="card">
        <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>
          命中列表 <span class="count">{hits.length}</span>
        </h2>
        <p class="sub" style={{ marginTop: 0, fontSize: "0.8rem" }}>
          由服务端在超温单办结时直接写入，页面只展示 /api/alert-hits 返回结果。
        </p>
        <table>
          <thead>
            <tr>
              <th>命中#</th>
              <th>读数#</th>
              <th>探头</th>
              <th>温度℃</th>
              <th>结论</th>
              <th>命中时间</th>
              <th>推送</th>
            </tr>
          </thead>
          <tbody>
            {hits.map((h) => (
              <tr key={h.id}>
                <td>{h.id}</td>
                <td>{h.reading_id}</td>
                <td>{h.probe_id}</td>
                <td>{h.temp_c}</td>
                <td>
                  <span class="tag fail">{h.verdict}</span>
                </td>
                <td>{fmt(h.hit_at)}</td>
                <td>
                  {h.push ? (
                    <span class="tag pass">
                      {h.push.channel}·{h.push.result}
                    </span>
                  ) : (
                    <span class="tag wait">缺流水</span>
                  )}
                </td>
              </tr>
            ))}
            {hits.length === 0 && (
              <tr>
                <td colspan="7">暂无命中（规则关闭期间办结的超温单不会进入此列表）</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>
          推送流水 <span class="count">{logs.length}</span>
        </h2>
        <table>
          <thead>
            <tr>
              <th>流水#</th>
              <th>命中#</th>
              <th>读数#</th>
              <th>探头</th>
              <th>温度℃</th>
              <th>渠道</th>
              <th>结果</th>
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
                <td>
                  <span class="tag pass">{p.result}</span>
                </td>
                <td>{fmt(p.pushed_at)}</td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr>
                <td colspan="8">暂无推送流水</td>
              </tr>
            )}
          </tbody>
        </table>
        {err && <p class="err">{err}</p>}
      </div>
    </>
  );
}
