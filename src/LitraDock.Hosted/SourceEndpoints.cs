using System.Net;
using System.Net.Sockets;
using LitraDock.Core;

namespace Literature.Service;

// 每次轉址與實際 socket 連線皆驗證；不讓已驗證的 DNS 名稱在第二次解析時換成私人位址。
public static class SourceEndpoints
{
    public static string Provider(Uri uri)
    {
        if (uri.Scheme != "https" || !uri.IsDefaultPort || uri.UserInfo != "" || uri.Fragment != "")
            throw new SourceException(
                "unsupported",
                "Only approved public HTTPS source endpoints are supported."
            );
        return uri.Host switch
        {
            "eutils.ncbi.nlm.nih.gov"
                when uri.AbsolutePath
                    is "/entrez/eutils/esearch.fcgi"
                        or "/entrez/eutils/efetch.fcgi" => "ncbi",
            "pmc.ncbi.nlm.nih.gov"
                when uri.AbsolutePath is "/api/oai/v1/mh/" or "/tools/idconv/api/v1/articles/" =>
                "ncbi",
            "www.ebi.ac.uk"
                when (
                    uri.AbsolutePath == "/europepmc/webservices/rest/search"
                    || System.Text.RegularExpressions.Regex.IsMatch(
                        uri.AbsolutePath,
                        "^/europepmc/webservices/rest/PMC[0-9]+/fullTextXML$"
                    )
                ) => "europepmc",
            _ => throw new SourceException(
                "unsupported",
                "Destination has no reviewed automated acquisition route; use its stable landing link manually."
            ),
        };
    }

    public static bool IsPublic(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6)
            address = address.MapToIPv4();
        var bytes = address.GetAddressBytes();
        if (address.AddressFamily == AddressFamily.InterNetworkV6)
            return (bytes[0] & 0xe0) == 0x20
                && !(bytes[0] == 0x20 && bytes[1] == 1 && bytes[2] < 2)
                && !(bytes[0] == 0x20 && bytes[1] == 1 && bytes[2] == 0x0d && bytes[3] == 0xb8)
                && !(bytes[0] == 0x20 && bytes[1] == 2)
                && !(bytes[0] == 0x3f && bytes[1] == 0xff);
        return bytes[0] != 0
            && bytes[0] != 10
            && bytes[0] != 127
            && bytes[0] < 224
            && !(bytes[0] == 100 && bytes[1] >= 64 && bytes[1] <= 127)
            && !(bytes[0] == 169 && bytes[1] == 254)
            && !(bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31)
            && !(bytes[0] == 192 && (bytes[1] == 168 || bytes[1] == 0 || bytes[1] == 2))
            && !(bytes[0] == 192 && bytes[1] == 88 && bytes[2] == 99)
            && !(bytes[0] == 198 && (bytes[1] == 18 || bytes[1] == 19 || bytes[1] == 51))
            && !(bytes[0] == 203 && bytes[1] == 0 && bytes[2] == 113);
    }

    public static SocketsHttpHandler CreateHandler() =>
        new()
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            UseProxy = false,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
            ConnectTimeout = TimeSpan.FromSeconds(10),
            MaxConnectionsPerServer = 2,
            PooledConnectionLifetime = TimeSpan.FromMinutes(2),
            ConnectCallback = async (context, cancellation) =>
            {
                Provider(context.InitialRequestMessage.RequestUri);
                var addresses = await Dns.GetHostAddressesAsync(
                    context.DnsEndPoint.Host,
                    cancellation
                );
                if (addresses.Length == 0 || addresses.Any(a => !IsPublic(a)))
                    throw new SourceException(
                        "unsupported",
                        "Source DNS includes a non-public address; no connection was made."
                    );
                foreach (var address in addresses)
                {
                    var socket = new Socket(
                        address.AddressFamily,
                        SocketType.Stream,
                        ProtocolType.Tcp
                    );
                    try
                    {
                        await socket.ConnectAsync(
                            new IPEndPoint(address, context.DnsEndPoint.Port),
                            cancellation
                        );
                        return new NetworkStream(socket, ownsSocket: true);
                    }
                    catch (SocketException)
                    {
                        socket.Dispose();
                    }
                    catch
                    {
                        socket.Dispose();
                        throw;
                    }
                }
                throw new HttpRequestException("Approved source connection failed.");
            },
        };
}
