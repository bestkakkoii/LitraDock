const $ = (id) => document.getElementById(id);
let csrf = "",
  library = "",
  scope = "",
  batch = "",
  offset = 0,
  libraryOffset = 0,
  catalogOffset = 0,
  itemOffset = 0,
  historyOffset = 0;
async function api(path, body) {
  const r = await fetch("/api/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-CSRF": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok)
    throw new Error(r.status === 401 ? "Sign in to continue." : await r.text());
  return r;
}
async function json(path, body) {
  return (await api(path, body)).json();
}
function safe(fn) {
  return async (event) => {
    event?.preventDefault();
    try {
      $("error").textContent = "";
      await fn(event);
    } catch (error) {
      $("error").textContent = error.message;
    }
  };
}
function base() {
  if (!library) throw new Error("Choose a library.");
  return "libraries/" + library + "/";
}
function options(id, rows, key, label, value) {
  $(id).replaceChildren(new Option("Choose " + id, ""));
  for (const row of rows) $(id).add(new Option(label(row), row[key]));
  $(id).value = value;
}
async function libraries() {
  const r = await json("libraries?offset=" + libraryOffset);
  $("libraryCounts").textContent =
    `Libraries ${r.total}; starting ${libraryOffset + 1}`;
  $("libraryNext").disabled = libraryOffset + 100 >= r.total;
  $("libraryPrevious").disabled = libraryOffset === 0;
  options("libraries", r.items, "library_id", (r) => r.name, library);
}
async function catalog() {
  if (!library) return;
  const r = await json("libraries/" + library + "?offset=" + catalogOffset);
  options(
    "runs",
    r.runs,
    "run_id",
    (x) => `${x.run_id}: ${x.fetched}/${x.total} ${x.state}`,
    $("runs").value,
  );
  options(
    "scopes",
    r.scopes,
    "scope_id",
    (x) => x.scope_id + " " + x.description,
    scope,
  );
  options(
    "batches",
    r.batches,
    "batch_id",
    (x) => x.batch_id + " " + x.state,
    batch,
  );
  $("catalogCounts").textContent =
    `Saved totals: runs ${r.totals.runs}, scopes ${r.totals.scopes}, batches ${r.totals.batches}; starting ${catalogOffset + 1}`;
  $("catalogNext").disabled =
    catalogOffset + 100 >=
    Math.max(r.totals.runs, r.totals.scopes, r.totals.batches);
  $("catalogPrevious").disabled = catalogOffset === 0;
}
async function page() {
  if (!scope) return;
  const p = await json(base() + `scopes/${scope}?offset=${offset}`);
  $("counts").textContent =
    `Scope ${p.total}; selected ${p.selected}; page starts ${offset + 1}`;
  $("records").replaceChildren();
  for (const { article: a, selected } of p.records) {
    const tr = document.createElement("tr");
    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = selected;
    c.setAttribute("aria-label", "Select " + a.pmid);
    c.onchange = safe(async () => {
      await api(base() + `scopes/${scope}/select`, {
        id: a.searchId,
        selected: c.checked,
      });
      await page();
    });
    tr.insertCell().append(c);
    for (const key of [
      "searchId",
      "title",
      "authors",
      "year",
      "doi",
      "pmid",
      "pmcid",
      "originalUri",
    ]) {
      const td = tr.insertCell();
      if (key === "title") {
        const b = document.createElement("button");
        b.textContent = a[key];
        b.onclick = safe(() => detail(a.searchId));
        td.append(b);
      } else if (["doi", "pmid", "pmcid", "originalUri"].includes(key)) {
        const link = document.createElement("a");
        link.textContent = a[key];
        link.href =
          a[
            {
              doi: "doiUri",
              pmid: "originalUri",
              pmcid: "pmcUri",
              originalUri: "originalUri",
            }[key]
          ];
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        td.append(link);
      } else td.textContent = a[key];
    }
    $("records").append(tr);
  }
  $("next").disabled = offset + 50 >= p.total;
  $("previous").disabled = offset === 0;
}
async function progress() {
  if (!batch) return;
  const r = await json(base() + "batches/" + batch + "?offset=" + itemOffset);
  $("status").textContent =
    r.state + ": " + r.counts.map((c) => `${c.state} ${c.count}`).join("; ");
  $("itemCounts").textContent = `Items starting ${itemOffset + 1}`;
  $("itemNext").disabled =
    itemOffset + 100 >= r.counts.reduce((n, c) => n + c.count, 0);
  $("itemPrevious").disabled = itemOffset === 0;
  $("progress").textContent = r.items
    .map(
      (i) =>
        `${i.rank}. ${i.search_id} ${i.state} (attempts ${i.attempts})\n${i.reason}\n${i.planned_name}`,
    )
    .join("\n\n");
}
async function download(path, body, name) {
  const blob = await (await api(path, body)).blob(),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function detail(id) {
  const r = await json(base() + "records/" + id);
  $("article").replaceChildren();
  for (const [k, v] of Object.entries(r.article)) {
    if (["rawXml", "fullTextMetadataXml"].includes(k)) continue;
    const p = document.createElement("p");
    p.textContent = `${k}: ${v}`;
    $("article").append(p);
  }
  for (const f of r.files) {
    const b = document.createElement("button");
    b.textContent = "Download original " + f.hash;
    b.onclick = safe(() =>
      download(
        base() + `records/${id}/files/${f.hash}`,
        undefined,
        id + ".xml",
      ),
    );
    $("article").append(b);
  }
  $("detail").showModal();
}
$("close").onclick = () => $("detail").close();
$("login").onsubmit = safe(async () => {
  const form = new FormData($("login"));
  const r = await json("login", {
    login: form.get("login"),
    password: form.get("password"),
  });
  csrf = r.csrf;
  $("login").reset();
  $("login").hidden = true;
  $("workspace").hidden = false;
  await libraries();
});
$("logout").onclick = safe(async () => {
  await api("logout", {});
  csrf = "";
  location.reload();
});
$("newLibrary").onclick = safe(async () => {
  library = (await json("libraries", { value: $("newName").value })).id;
  await libraries();
  await catalog();
});
$("libraries").onchange = safe(async () => {
  library = $("libraries").value;
  scope = "";
  batch = "";
  catalogOffset = 0;
  itemOffset = 0;
  historyOffset = 0;
  await catalog();
});
$("search").onclick = safe(async () => {
  const r = await json(base() + "search", {
    query: $("query").value,
    limit: Number($("limit").value),
  });
  await catalog();
  $("runs").value = r.id;
});
$("runScope").onclick = safe(async () => {
  scope = (await json(base() + "scopes", { run: $("runs").value || null })).id;
  offset = 0;
  await catalog();
  await page();
});
$("snapshot").onclick = safe(async () => {
  scope = (await json(base() + "scopes", {})).id;
  offset = 0;
  await catalog();
  await page();
});
$("scopes").onchange = safe(async () => {
  scope = $("scopes").value;
  offset = 0;
  await page();
});
$("refine").onclick = safe(async () => {
  scope = (
    await json(base() + "scopes", { parent: scope, text: $("filter").value })
  ).id;
  offset = 0;
  await catalog();
  await page();
});
$("next").onclick = safe(async () => {
  offset += 50;
  await page();
});
$("previous").onclick = safe(async () => {
  offset = Math.max(0, offset - 50);
  await page();
});
$("selectAll").onclick = safe(async () => {
  await api(base() + `scopes/${scope}/select`, { selected: true });
  await page();
});
$("export").onclick = safe(() =>
  download(base() + `scopes/${scope}/export`, {}, "LitraDock.xlsx"),
);
$("acquire").onclick = safe(async () => {
  batch = (
    await json(base() + "batches", {
      scope,
      selectedOnly: $("selectedOnly").checked,
      template: $("template").value,
    })
  ).id;
  await catalog();
  await progress();
});
$("batches").onchange = safe(async () => {
  batch = $("batches").value;
  itemOffset = 0;
  await progress();
});
document.querySelectorAll("[data-action]").forEach(
  (b) =>
    (b.onclick = safe(async () => {
      await api(base() + `batches/${batch}/control`, {
        action: b.dataset.action,
      });
      await progress();
    })),
);
async function history() {
  const r = await json(base() + "history?offset=" + historyOffset);
  $("events").textContent = JSON.stringify(r, null, 2);
  $("historyNext").disabled = r.length < 100;
  $("historyPrevious").disabled = historyOffset === 0;
}
$("history").onclick = safe(history);
for (const [prefix, change, refresh] of [
  ["library", (d) => (libraryOffset += d), libraries],
  ["catalog", (d) => (catalogOffset += d), catalog],
  ["item", (d) => (itemOffset += d), progress],
  ["history", (d) => (historyOffset += d), history],
]) {
  for (const [suffix, delta] of [
    ["Next", 100],
    ["Previous", -100],
  ])
    $(prefix + suffix).onclick = safe(async () => {
      change(delta);
      await refresh();
    });
}
try {
  csrf = (await json("session")).csrf;
  $("login").hidden = true;
  $("workspace").hidden = false;
  await libraries();
} catch {}
setInterval(
  safe(async () => {
    if (csrf && library) {
      await catalog();
      await progress();
    }
  }),
  2000,
);
