using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using NuGet.Packaging;

try
{
    if (args.Length == 1 && args[0] == "brotli")
    {
        using var input = new MemoryStream(Convert.FromBase64String(Console.In.ReadToEnd()));
        using var decoder = new BrotliStream(input, CompressionMode.Decompress);
        using var output = new MemoryStream();
        var buffer = new byte[8192];
        int read;
        while ((read = decoder.Read(buffer)) > 0)
        {
            if (output.Length + read > 1024 * 1024) throw new InvalidDataException();
            output.Write(buffer, 0, read);
        }
        Console.WriteLine(Convert.ToHexStringLower(SHA256.HashData(output.ToArray())));
        return;
    }
    if (args.Length != 2 || new FileInfo(args[0]).Length > 256L * 1024 * 1024)
        throw new ArgumentException();
    using var reader = new PackageArchiveReader(args[0]);
    // 使用 SDK 的 NuGet 實作驗證簽署封裝完整性；不自行重寫 ZIP 簽署雜湊演算法，也不宣稱憑證信任。
    var signature = await reader.GetPrimarySignatureAsync(CancellationToken.None);
    if (signature != null) await reader.ValidateIntegrityAsync(signature.SignatureContent, CancellationToken.None);
    var contentHash = reader.GetContentHash(CancellationToken.None);
    if (contentHash != args[1]) throw new InvalidDataException();
    Console.WriteLine(JsonSerializer.Serialize(new
    {
        contentHash, signedContentIntegrityChecked = signature != null,
        certificateTrustVerified = false,
        nugetAssemblyVersion = typeof(PackageArchiveReader).Assembly.GetName().Version.ToString(),
    }));
}
catch
{
    Console.Error.WriteLine("Offline content verification failed.");
    Environment.ExitCode = 2;
}
