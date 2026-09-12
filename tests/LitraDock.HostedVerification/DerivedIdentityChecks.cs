using System.Text.Json.Nodes;
using Literature.Service;
using LitraDock.Core;

public static class DerivedIdentityChecks
{
    public static async Task Run(string output, Action<bool,string> check)
    {
        foreach(var id in new[]{"LD-00112233445566778899aabbccddeeff","LD-ffffffffffffffffffffffffffffffff"})
        {
            var result=await DocumentProcess.Run(new {operation="reading",id,title="Synthetic identifier shaping regression",source="Synthetic body 中文",format="text",mode="original",inputHash=new string('b',64)},CancellationToken.None);
            var bytes=Convert.FromBase64String(result["pdf"].GetValue<string>());
            var info=await PdfInspection.Inspect(bytes,new Article{SearchId=id},false,result["kind"].GetValue<string>());
            check(info.Hash==Artifacts.Hash(bytes),"PDFID01 actual Chromium shaped ff identifier passes unchanged strict PDF identity validation: "+id);
            var rejected=false;
            try { await PdfInspection.Inspect(bytes,new Article{SearchId="LD-another-record"},false,result["kind"].GetValue<string>()); }
            catch(SourceException) { rejected=true; }
            check(rejected,"PDFID02 different canonical identity is still rejected");
            await File.WriteAllTextAsync(Path.Combine(output,id+".json"),new JsonObject { ["id"]=id,["hash"]=info.Hash,["bytes"]=bytes.Length,["renderer"]=result["renderer"].DeepClone(),["fontHash"]=result["fontHash"].DeepClone() }.ToJsonString());
        }
    }
}
