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
  $(id).replaceChildren(new Option(({reviewVersion:"No exact version selected",conversionOriginal:"Choose saved original",reviewProject:"Choose project"})[id] ?? "Choose " + id, ""));
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
let previewRecord = "";
async function page() {
  if (!scope) return;
  const p = await json(base() + `scopes/${scope}?offset=${offset}`);
  previewRecord = p.records[0]?.article.searchId || "";
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
let progressGeneration = 0;
async function progress() {
  if (!batch) return;
  const generation = ++progressGeneration,
    requestedBatch = batch,
    requestedLibrary = library;
  const r = await json(base() + "batches/" + batch + "?offset=" + itemOffset);
  if (
    generation !== progressGeneration ||
    requestedBatch !== batch ||
    requestedLibrary !== library
  )
    return;
  const currentOption = Array.from($("batches").options).find(
    (option) => option.value === batch,
  );
  if (currentOption) currentOption.textContent = batch + " " + r.state;
  $("status").textContent =
    r.state + ": " + r.counts.map((c) => `${c.state} ${c.count}`).join("; ");
  $("itemCounts").textContent = `Items starting ${itemOffset + 1}`;
  $("itemNext").disabled =
    itemOffset + 100 >= r.counts.reduce((n, c) => n + c.count, 0);
  $("itemPrevious").disabled = itemOffset === 0;
  $("progress").replaceChildren();
  for (const i of r.items) {
    const row = document.createElement("section");
    row.className = "acquisition-item";
    const label = document.createElement("p");
    label.textContent = `${i.rank}. ${i.search_id}: ${i.state} · attempts ${i.attempts} · ${i.reason} · ${i.planned_name}`;
    row.append(label);
    const open = document.createElement("button");
    open.textContent = "Record and source links";
    open.onclick = safe(() => detail(i.search_id));
    row.append(open);
    if (!["queued", "running"].includes(r.state)) {
      const upload = document.createElement("button");
      upload.textContent =
        i.state === "needs_review"
          ? "Review retained original"
          : "Continue with original";
      upload.onclick = safe(() => openManual(i.search_id, i.item_id, i.state));
      row.append(upload);
    }
    $("progress").append(row);
  }
}
async function download(path, body, name) {
  const response = await api(path, body);
  if (!name) {
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(
      response.headers.get("Content-Disposition") || "",
    );
    name = encoded ? decodeURIComponent(encoded[1]) : "original";
  }
  const blob = await response.blob(),
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
      download(base() + `records/${id}/files/${f.hash}`, undefined, undefined),
    );
    $("article").append(b);
  }
  const manualButton = document.createElement("button");
  manualButton.textContent = "Upload an original to this record";
  manualButton.onclick = safe(async () => {
    const saved = await json(base() + `records/${id}/manual-item`, {});
    scope = saved.scope;
    batch = saved.batch;
    $("detail").close();
    await catalog();
    await progress();
    await openManual(id, saved.item, "paused");
  });
  $("article").append(manualButton);
  const researchButton=document.createElement("button");researchButton.textContent="Review, notes and reading copies";researchButton.onclick=safe(async()=>{$("detail").close();await openResearch(id);});$("article").append(researchButton);
  const provenance = document.createElement("pre");
  provenance.textContent = JSON.stringify(r.provenance, null, 2);
  $("article").append(provenance);
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
  download(
    base() + `scopes/${scope}/export`,
    { selectedOnly: $("exportSelected").checked },
    "LitraDock.xlsx",
  ),
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
$("previewName").onclick = safe(async () => {
  if (!previewRecord) throw new Error("Open a result scope first.");
  const preview = await json(base() + `records/${previewRecord}/name-preview`, {
    value: $("template").value,
  });
  $("namePreview").textContent = preview.name + " · " + preview.note;
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
      const events=await json(base()+"next-events");
      $("nextEvents").textContent=events.total ? `Automatic events ${events.total}; showing first ${events.limit}.\n`+events.items.map(x=>`${x.job_id}: ${x.status} · next eligible ${x.next_at} · automatic attempt ${x.number}`).join("\n") : "No automatic continuation is pending.";
    }
  }),
  2000,
);

$("csv").onclick = safe(() =>
  download(
    base() + `scopes/${scope}/csv`,
    { selectedOnly: $("exportSelected").checked },
    "literature-csv.zip",
  ),
);
let manualRecord = "",
  manualItem = "",
  manualLibrary = "";
async function openManual(record, item, state) {
  manualRecord = record;
  manualItem = item;
  manualLibrary = library;
  $("manualIdentity").textContent = record + " · " + item;
  const details = await json(base() + "records/" + record);
  $("manualIdentity").textContent +=
    "\n" +
    details.article.title +
    "\n" +
    details.article.authors +
    "\nDOI: " +
    details.article.doi +
    " · PMID: " +
    details.article.pmid +
    " · PMCID: " +
    details.article.pmcid;
  $("manualFile").value = "";
  $("manualStatus").textContent = "";
  $("manualConfirmed").checked = false;
  $("identityReview").hidden = state !== "needs_review";
  $("manualDialog").showModal();
}
$("manualClose").onclick = () => $("manualDialog").close();
$("manualUpload").onclick = safe(async () => {
  const file = $("manualFile").files[0];
  if (!file || file.size > 32 * 1024 * 1024)
    throw new Error("Choose an original up to 32 MiB.");
  $("manualStatus").textContent = "Uploading and validating; not complete yet.";
  const r = await fetch(
    `/api/libraries/${manualLibrary}/records/${manualRecord}/manual/${manualItem}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-CSRF": csrf,
        "X-Original-Source": $("manualSource").value,
        "X-Original-Version": $("manualVersion").value,
      },
      body: file,
    },
  );
  if (!r.ok) throw new Error(await r.text());
  $("manualStatus").textContent = (await r.json()).message;
  await progress();
  const status = await json(
    base() + "batches/" + batch + "?offset=" + itemOffset,
  );
  $("identityReview").hidden =
    status.items.find((i) => i.item_id === manualItem)?.state !==
    "needs_review";
});
$("manualConfirm").onclick = safe(async () => {
  if (!$("manualConfirmed").checked)
    throw new Error(
      "Review and explicitly confirm the record relationship first.",
    );
  await json(
    `libraries/${manualLibrary}/records/${manualRecord}/manual/${manualItem}/confirm`,
    {},
  );
  $("identityReview").hidden = true;
  $("manualStatus").textContent =
    "Your identity confirmation is recorded; durable publication is queued.";
  await progress();
});

let healthOffset=0;
$("health").onclick=safe(async()=>{
  $("recoveryStatus").textContent="Checking bounded file-health page; originals remain untouched.";
  const result=await json(base()+"health",{offset:healthOffset});
  healthOffset=result.nextOffset;
  $("recoveryStatus").textContent=JSON.stringify(result,null,2);
});
$("bundle").onclick=safe(async()=>{
  $("recoveryStatus").textContent="Preparing private bundle; completion is not yet confirmed.";
  await download(base()+"bundle",{},"private-library.zip");
  $("recoveryStatus").textContent="Private bundle downloaded. Missing files are declared in its manifest and prevent restore.";
});
$("restoreBundle").onclick=safe(async()=>{
  const file=$("bundleFile").files[0];
  if(!file || file.size>256*1024*1024) throw new Error("Choose a private bundle up to 256 MiB.");
  const initialCsrf=csrf, initialLibrary=library;
  $("restoreBundle").disabled=true;
  try {
    let response;
    for(let attempt=0;attempt<4;attempt++) {
      if(csrf!==initialCsrf || library!==initialLibrary) throw new Error("Account or library changed; choose the restore context again.");
      $("recoveryStatus").textContent="Validating and restoring into a new library; no completion is assumed.";
      response=await fetch("/api/restore",{method:"POST",headers:{"Content-Type":"application/octet-stream","X-CSRF":initialCsrf},body:file});
      if(response.status!==429 || response.headers.get("X-Operation-Admission")!=="not-started" || attempt===3) break;
      const admission=await response.clone().json().catch(()=>null);
      if(admission?.code!=="admission_not_started") break;
      const seconds=Math.min(10,Math.max(1,Number(response.headers.get("Retry-After"))||2));
      $("recoveryStatus").textContent=`Service capacity is in use; restore has not started. Waiting ${seconds} seconds before admission retry ${attempt+1} of 3.`;
      await new Promise(resolve=>setTimeout(resolve,seconds*1000));
    }
    if(!response.ok) {
      const problem=await response.json().catch(()=>({error:"Request rejected."}));
      throw new Error(`Restore response ${response.status}: ${problem.error||"Request rejected."} Inspect transfer history before another upload.`);
    }
    const result=await response.json(); library=result.id; scope="";batch="";healthOffset=0;
    $("records").replaceChildren();$("progress").replaceChildren();$("counts").textContent="Choose a restored scope.";$("status").textContent="Restored library; unfinished work is paused.";
    await libraries();await catalog();$("recoveryStatus").textContent=result.message;
  } catch(error) {
    $("recoveryStatus").textContent=error.message+" No completion is assumed; inspect transfer history.";
    throw error;
  } finally {$("restoreBundle").disabled=false;}
});

$("transferHistory").onclick=safe(async()=>{$("recoveryStatus").textContent=JSON.stringify(await json("transfers"),null,2);});

let researchEpoch=0,projectOffset=0,researchOffset=0,researchRecord="",researchLibrary="",researchData=null,reviewRevision=0;
async function loadProjects(){const epoch=researchEpoch;const rows=await json(base()+"projects");if(epoch!==researchEpoch)return [];options("projects",rows,"project_id",x=>x.name,$("projects").value);return rows;}
async function projectPage(){const epoch=researchEpoch;if(!$("projects").value)return;const r=await json(base()+`projects/${$("projects").value}?offset=${projectOffset}`);if(epoch!==researchEpoch)return;$("projectCounts").textContent=`Project records ${r.total}; starting ${projectOffset+1}`;$("projectPrevious").disabled=projectOffset===0;$("projectNext").disabled=projectOffset+50>=r.total;$("projectRecords").replaceChildren();for(const row of r.records){const b=document.createElement("button");b.textContent=`${row.search_id}: ${row.state} · ${JSON.parse(row.metadata).Title}`;b.onclick=safe(()=>openResearch(row.search_id));$("projectRecords").append(b);}}
$("loadProjects").onclick=safe(loadProjects);
$("createProject").onclick=safe(async()=>{const r=await json(base()+"projects",{name:$("projectName").value});await loadProjects();$("projects").value=r.id;await projectPage();});
$("projects").onchange=safe(async()=>{projectOffset=0;await projectPage();});
$("projectPrevious").onclick=safe(async()=>{projectOffset=Math.max(0,projectOffset-50);await projectPage();});
$("projectNext").onclick=safe(async()=>{projectOffset+=50;await projectPage();});
function researchBase(){if(library!==researchLibrary)throw new Error("Library changed; reopen the research record.");return `libraries/${researchLibrary}/`;}
function loadReviewForm(){const r=researchData?.reviews.find(x=>x.project_id===$("reviewProject").value);reviewRevision=r?.revision??0;$("reviewState").value=r?.state??"unscreened";$("reviewTags").value=r?.tags??"";$("reviewReason").value=r?.reason??"";$("reviewNote").value=r?.note??"";const e=JSON.parse(r?.evidence??"{}");$("reviewVersion").value=e.hash??"";$("reviewQuote").value=e.quote??"";$("reviewSection").value=e.section??"";$("reviewPage").value=e.page??"";$("reviewPageKind").value=e.pageKind??"source";}
async function refreshResearch(){
  const epoch=researchEpoch;const r=await json(researchBase()+`records/${researchRecord}/research?offset=${researchOffset}`);if(epoch!==researchEpoch)return;researchData=r;
  $("researchCounts").textContent=`Conversions ${r.counts.conversions}; derived files ${r.counts.derivations}; decision events ${r.counts.history}; page starts ${researchOffset+1}`;
  $("researchPrevious").disabled=researchOffset===0;$("researchNext").disabled=researchOffset+100>=Math.max(r.counts.conversions,r.counts.derivations,r.counts.history);
  $("conversionList").replaceChildren();for(const c of r.conversions){const row=document.createElement("section");const p=document.createElement("p");p.textContent=`${c.conversion_id}: ${c.state}; attempts ${c.attempts}. ${c.reason}`;row.append(p);for(const action of c.state==="completed"?[]:c.state==="running"||c.state==="queued"?["pause","cancel"]:["resume","cancel"]){const b=document.createElement("button");b.textContent=action+" conversion";b.onclick=safe(async()=>{await json(researchBase()+`conversions/${c.conversion_id}/control`,{action});await refreshResearch();});row.append(b);}$("conversionList").append(row);}
  $("derivedList").replaceChildren();for(const d of r.derivations){const b=document.createElement("button");b.textContent=`Download ${d.kind} ${d.hash.slice(0,12)}`;b.onclick=safe(()=>download(researchBase()+`records/${researchRecord}/derived/${d.derivation_id}/files`,undefined,undefined));const p=document.createElement("p");const details=JSON.parse(d.provenance);p.textContent=`Input ${details.inputHash}; ${details.renderer}; ${details.warnings?.join(" ")||"Inspect saved conversion coverage."}`;$("derivedList").append(b,p);if(!Array.from($("reviewVersion").options).some(x=>x.value===d.hash))$("reviewVersion").add(new Option(`Derived: ${d.kind} ${d.hash}`,d.hash));}
  $("reviewHistory").textContent=r.history.map(x=>`${x.created_at} · ${x.actor} · revision ${x.revision}\n${x.data}`).join("\n\n");
}
async function openResearch(id){const epoch=researchEpoch;researchRecord=id;researchLibrary=library;researchOffset=0;const original=await json(researchBase()+`records/${id}`);if(epoch!==researchEpoch)return;$("researchTitle").textContent=original.article.title;$("researchIdentity").textContent=`${id} · DOI ${original.article.doi} · PMID ${original.article.pmid} · PMCID ${original.article.pmcid}`;const projects=await loadProjects();if(epoch!==researchEpoch)return;options("reviewProject",projects,"project_id",x=>x.name,$("projects").value);options("conversionOriginal",original.files,"hash",x=>x.kind+" "+x.hash,original.files[0]?.hash??"");options("reviewVersion",original.files,"hash",x=>"Original: "+x.hash,"");await refreshResearch();if(epoch!==researchEpoch)return;loadReviewForm();$("reviewStatus").textContent="";$("researchDialog").showModal();}
$("researchClose").onclick=()=>$("researchDialog").close();
$("reviewProject").onchange=loadReviewForm;
$("saveReview").onclick=safe(async()=>{if(!$("reviewProject").value)throw new Error("Choose or create a project first.");const evidence={hash:$("reviewVersion").value,quote:$("reviewQuote").value,section:$("reviewSection").value,pageKind:$("reviewPageKind").value};if($("reviewPage").value)evidence.page=$("reviewPage").value;const r=await json(researchBase()+`projects/${$("reviewProject").value}/records/${researchRecord}`,{state:$("reviewState").value,tags:$("reviewTags").value,note:$("reviewNote").value,reason:$("reviewReason").value,evidence:JSON.stringify(evidence),revision:reviewRevision});reviewRevision=r.revision;$("reviewStatus").textContent=`Project decision saved at revision ${r.revision}; acquisition is unchanged.`;await refreshResearch();});
for(const [id,mode] of [["convertOriginal","original"],["convertAbstract","abstract"]])$(id).onclick=safe(async()=>{await json(researchBase()+`records/${researchRecord}/conversions`,{hash:$("conversionOriginal").value,mode});await refreshResearch();});
$("refreshResearch").onclick=safe(refreshResearch);
$("researchPrevious").onclick=safe(async()=>{researchOffset=Math.max(0,researchOffset-100);await refreshResearch();});
$("researchNext").onclick=safe(async()=>{researchOffset+=100;await refreshResearch();});
setInterval(()=>{if($("researchDialog").open)refreshResearch().catch(error=>{$("reviewStatus").textContent=error.message;});},2500);
let citationUrl=null,citationExpiry=null,citationGeneration=0;
function clearCitationDownload(){citationGeneration++;if(citationUrl)URL.revokeObjectURL(citationUrl);citationUrl=null;clearTimeout(citationExpiry);$("citationSave").hidden=true;$("citationSave").removeAttribute("href");$("citationReady").textContent="";}
async function prepareCitation(path,request,name){
  clearCitationDownload();const generation=citationGeneration,ownerLibrary=library,ownerScope=scope;
  $("citationReady").textContent="Preparing citation file…";
  const response=await api(path,request);const blob=await response.blob();
  if(generation!==citationGeneration||library!==ownerLibrary||scope!==ownerScope)throw new Error("Library or scope changed; prepare the citation file again.");
  citationUrl=URL.createObjectURL(blob);const link=$("citationSave");link.href=citationUrl;link.download=name;link.textContent="Save "+name;link.hidden=false;
  $("citationReady").textContent=`File ready for ${ownerScope}. Use Save; the private link expires in two minutes.`;
  citationExpiry=setTimeout(()=>{clearCitationDownload();$("citationReady").textContent="Prepared citation expired; prepare it again when needed.";},120000);
}
function clearResearchContext(){
  researchEpoch++;clearCitationDownload();$("citationOutput").textContent="";$("projectRecords").replaceChildren();$("projects").replaceChildren();$("projectCounts").textContent="Load projects for this library.";
  $("researchDialog").close();researchRecord="";researchLibrary="";researchData=null;researchOffset=0;projectOffset=0;
}
$("libraries").addEventListener("change",clearResearchContext);
$("newLibrary").addEventListener("click",clearResearchContext);
$("restoreBundle").addEventListener("click",clearResearchContext);
$("logout").addEventListener("click",clearResearchContext);
async function citationAction(format){if(!scope)throw new Error("Choose a saved result scope.");const request={style:$("citationStyle").value,format,selectedOnly:$("citationSelected").checked};if(format==="preview"){const r=await json(base()+`scopes/${scope}/citations`,request);$("citationOutput").textContent=`${r.processor} · ${r.style} · ${r.styleHash}\n${r.citation}\n\n${r.bibliography.join("\n\n")}\n\n${r.items.map(x=>`${x.id}: ${x.custom.missingMetadata.join(" ")}`).join("\n")}`;}else await prepareCitation(base()+`scopes/${scope}/citations`,request,{ris:"references.ris",bibtex:"references.bib","csl-json":"references.csl.json",text:"bibliography.txt"}[format]);}
for(const [id,format] of [["citationPreview","preview"],["citationRis","ris"],["citationBib","bibtex"],["citationJson","csl-json"],["citationText","text"]])$(id).onclick=safe(()=>citationAction(format));
$("scopedBundle").onclick=safe(async()=>{if(!scope)throw new Error("Choose a saved scope.");await download(base()+`scopes/${scope}/bundle`,{selectedOnly:$("bundleSelected").checked},"selected-library.zip");});
