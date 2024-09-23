addEventListener('fetch', event => {
    event.respondWith(handleRequest(event))
})

async function serveAsset(event) {
    const url = new URL(event.request.url);
    const cache = caches.default;
    let response = await cache.match(event.request);

    try {
        if (!response) {
            if (url.pathname === "/favicon.ico") {
                await fetch("https://flawcra.cc/favicon.ico").then(async function (tmpResp) {
                    const headers = {
                        'cache-control': 'public, max-age=14400',
                        'Access-Control-Allow-Origin': '*',
                        'Content-Length': tmpResp.headers.get("content-length"),
                        'Content-Type': tmpResp.headers.get("content-type")
                    };
                    response = new Response(tmpResp.body, {...tmpResp, headers, status: 200});
                    await cache.put(event.request, response.clone());
                }).catch(function (err) {
                    response = new Response("Error while resolving URL: " + err.toString(), {status: 422});
                });
                return response;
            }

            let currentUrl = "https://w.soundcloud.com/player/";

            console.log(currentUrl);
            let req = await fetch("https://w.soundcloud.com/player/");
            req = await req.text();
            let jsFile = req.split("sndcdn.com/widget-9-")[1].split('.js')[0];

            currentUrl = `https://widget.sndcdn.com/widget-9-${jsFile}.js`;
            console.log(currentUrl);
            req = await fetch(currentUrl);
            req = await req.text();

            let soundCloudID = req.split("client_id")[1].split('"')[1];

            currentUrl = "https://api-v2.soundcloud.com/resolve?url=https://soundcloud.com" + url.pathname + "&client_id=" + soundCloudID;
            console.log(currentUrl);
            await fetch(currentUrl).then(async function (tmpResp) {

                let tmpJson = await tmpResp.json();
                    switch (tmpJson.kind) {
                        case "track":

                            let streamUrl = "";
                            console.log(tmpJson);
                            for(const transocing of tmpJson.media.transcodings) {
                                if(transocing.format.mime_type === "audio/mpeg") {
                                    streamUrl = transocing.url;
                                    break;
                                }
                            }

                            if(streamUrl === "") {
                                response = new Response("", {statusText: "Couldn't find HLS stream url", status: 422})
                                break;
                            }

                            streamUrl = streamUrl + "?client_id=" + soundCloudID;

                            console.log(streamUrl);
                            streamUrl = await fetch(streamUrl);
                            streamUrl = await streamUrl.json();
                            streamUrl = streamUrl.url;

                            // Implementing the Fetch HLS playlist, concatenate MP3 parts, and serve as a single MP3 file
                            let playlistResponse = await fetch(streamUrl);
                            let playlistText = await playlistResponse.text();

                            // Parse the playlist to get MP3 part URLs
                            let lines = playlistText.split('\n');
                            let mediaUrls = [];
                            for (let line of lines) {
                                line = line.trim();
                                if (line && !line.startsWith('#')) {
                                    let mediaUrl = new URL(line, streamUrl).toString();
                                    mediaUrls.push(mediaUrl);
                                }
                            }

                            // Create a TransformStream to pipe the MP3 parts
                            let { readable, writable } = new TransformStream();

                            (async () => {
                                const writer = writable.getWriter();

                                try {
                                    for (let mediaUrl of mediaUrls) {
                                        const partResponse = await fetch(mediaUrl);
                                        if (!partResponse.ok) {
                                            throw new Error(`Failed to fetch MP3 part: ${mediaUrl}`);
                                        }
                                        const reader = partResponse.body.getReader();
                                        while (true) {
                                            const { done, value } = await reader.read();
                                            if (done) break;
                                            await writer.write(value);
                                        }
                                    }
                                    await writer.close();
                                } catch (error) {
                                    console.error(error);
                                    await writer.abort(error);
                                }
                            })();

                            var headers = {};
                            headers['cache-control'] = "public, max-age=14400";
                            headers['Access-Control-Allow-Origin'] = "*";
                            headers['Content-Type'] = "audio/mpeg";
                            headers['Content-Encoding'] = "deflate";
                            headers['Content-Disposition'] = `filename="${tmpJson.user.username} - ${tmpJson.title}.mp3"`;
                            headers['X-Content-Duration'] = tmpJson.duration / 1000;
                            response = new Response(readable, {headers});
                            break;
                        case "playlist":
                            let tracks = tmpJson.tracks;

                            for(let i = 0; i < tracks.length; i++) {
                                let trck = await fetch("https://api-v2.soundcloud.com/tracks/" + tracks[i].id + "?client_id=" + soundCloudID);
                                tracks[i] = await trck.json();
                            }

                            let outStr = `#EXTM3U\n`;
                            for (let track of tracks) {
                                outStr += generateOutStr(track);
                            }
                            var ctType = "application/x-mpegURL";
                            var headers = {
                                'cache-control': 'public, max-age=14400',
                                'Access-Control-Allow-Origin': '*',
                                'Content-Type': ctType
                            };
                            response = new Response(outStr, {headers, statusText: "OK", status: 200});
                            response.status = 200;
                            break;
                        default:
                            var headers = {
                                'cache-control': 'public, max-age=14400',
                                'Access-Control-Allow-Origin': '*',
                                'content-type': "plain/html",
                                'Content-Encoding': 'deflate'
                            }
                            response = new Response("NOT IMPLEMENTED YET!", {
                                headers,
                                statusText: "Not Implemented",
                                status: 501
                            });
                            break;
                    }
            }).catch(function (er) {
                console.error(er);
                response = new Response("", {statusText: "Error while resolving URL", status: 422})
            });
        }
    } catch (err) {
        console.error(err);
        response = new Response(err.toString(), {statusText: "Error while resolving URL", status: 422})
    }

    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.set('Access-Control-Allow-Methods', '*');
    response.headers.set('Access-Control-Allow-Headers', '*');

    return response;
}

function generateOutStr(track) {
    let tmp = `#EXTINF:${track.duration / 1000} tvg-id="" tvg-name="${track.user.username} - ${track.title}" tvg-country="" tvg-language="" tvg-logo="" group-title="",${track.user.username} - ${track.title}\n`;
    tmp += track.permalink_url.replace("soundcloud.com", "scr.flawcra.cc") + `\n`;
    return tmp
}

async function handleRequest(event) {
    if (event.request.method === 'GET') {
        let response= await serveAsset(event);
        if (response.status > 399) {
            response = new Response(response.statusText + `(${response.status}) (C)FlawCra`, {status: response.status})
        }
        return response
    } else {
        return new Response('Method not allowed', {status: 405})
    }
}
