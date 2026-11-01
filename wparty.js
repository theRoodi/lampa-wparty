(function () {
    'use strict';

    function startPlugin() {
        if (window.plugin_wparty_ready) return;
        window.plugin_wparty_ready = true;

        var network = new Lampa.Reguest();
        var WPARTY_API = 'https://wparty.net/api';

        // Register plugin in LAMPA manifest
        var manifest = {
            type: 'video',
            version: '1.2.0',
            name: 'WParty - Без рекламы',
            description: 'Онлайн просмотр без рекламы через WParty',
            component: 'wparty',
            onContextMenu: function (object) {
                return {
                    name: 'WParty',
                    description: 'Онлайн просмотр без рекламы'
                };
            },
            onContextLauch: function (object) {
                startWParty(object);
            }
        };
        try {
            Lampa.Manifest.plugins = manifest;
        } catch (e) {}

        // Component stub for Sources menu
        try {
            Lampa.Component.add('wparty', function () {
                this.create = function () {};
                this.start = function () {
                    var act = Lampa.Activity.active();
                    if (act && act.movie) {
                        startWParty(act.movie);
                    }
                };
                this.destroy = function () {};
            });
        } catch (e) {}

        // Global AdBlock & CUB Premium Bypass
        try {
            // 1. Force developer ads to false
            if (!window.lampa_settings) window.lampa_settings = {};
            if (!window.lampa_settings.developer) window.lampa_settings.developer = {};
            window.lampa_settings.developer.ads = false;

            // 2. Storage hook: ensure account_user always returns an active premium date
            if (Lampa.Storage) {
                var origStorageGet = Lampa.Storage.get;
                Lampa.Storage.get = function (name, def) {
                    if (name === 'account_user') {
                        var u = origStorageGet.call(Lampa.Storage, name, def);
                        if (!u || typeof u !== 'object') u = {};
                        u.id = u.id || 1;
                        u.user_id = u.user_id || 1;
                        u.premium = '2099-12-31';
                        return u;
                    }
                    if (name === 'developer_nopremium') {
                        return false;
                    }
                    return origStorageGet.call(Lampa.Storage, name, def);
                };

                // Persist premium status in storage
                var curUser = origStorageGet.call(Lampa.Storage, 'account_user', '{}');
                if (!curUser || typeof curUser !== 'object') curUser = {};
                curUser.id = curUser.id || 1;
                curUser.premium = '2099-12-31';
                Lampa.Storage.set('account_user', curUser);
                Lampa.Storage.set('developer_nopremium', false);
            }

            // 3. Account API hook
            if (Lampa.Account && Lampa.Account.Api && Lampa.Account.Api.user) {
                var origApiUser = Lampa.Account.Api.user;
                Lampa.Account.Api.user = function (cb) {
                    origApiUser.call(Lampa.Account.Api, function (u) {
                        if (u && typeof u === 'object') {
                            u.premium = '2099-12-31';
                        }
                        if (cb) cb(u);
                    });
                };
            }

            // 4. Intercept player calls: strip vast URLs from balancers
            if (Lampa.Player && Lampa.Player.play) {
                var originalPlayerPlay = Lampa.Player.play;
                Lampa.Player.play = function (data) {
                    if (data) {
                        if (data.vast_url) {
                            console.log('[WParty AdBlock] Stripped vast_url:', data.vast_url);
                            delete data.vast_url;
                        }
                        if (data.vast_msg) delete data.vast_msg;
                    }
                    return originalPlayerPlay.call(Lampa.Player, data);
                };
            }
        } catch (e) {
            console.error('[WParty AdBlock] Error:', e);
        }

        function searchWParty(title, year, callback) {
            var cleanTitle = title.replace(/[:\/\\?*|<>&]/g, ' ').trim();
            
            network.silent(WPARTY_API + '/movieSearch', function (data) {
                if (Array.isArray(data) && data.length > 0) {
                    var found = data[0];
                    if (year) {
                        for (var i = 0; i < data.length; i++) {
                            if (data[i].year && data[i].year.toString() === year.toString()) {
                                found = data[i];
                                break;
                            }
                        }
                    }
                    callback(found);
                } else {
                    callback(null);
                }
            }, function () {
                callback(null);
            }, JSON.stringify({ q: cleanTitle }), {
                headers: { 'Content-Type': 'application/json' },
                contentType: 'application/json; charset=UTF-8',
                dataType: 'json'
            });
        }

        function checkSources(kpId, callback) {
            network.silent(WPARTY_API + '/movieCheck', function (sources) {
                if (Array.isArray(sources) && sources.length > 0) {
                    callback(sources);
                } else {
                    callback([]);
                }
            }, function () {
                callback([]);
            }, JSON.stringify({ id: Number(kpId) }), {
                headers: { 'Content-Type': 'application/json' },
                contentType: 'application/json; charset=UTF-8',
                dataType: 'json'
            });
        }

        function resolveStream(kpId, sourceName, translationId, callback) {
            network.silent(WPARTY_API + '/createRoom', function (room) {
                var roomId = room && room.name;
                if (!roomId) {
                    return callback(null);
                }

                network.silent(WPARTY_API + '/resolveShard/' + roomId, function (shard) {
                    var shardNum = Number(shard) || 1;
                    var clientId = 'lampa_' + Math.random().toString(36).substring(2, 10);
                    var wsUrl = 'wss://wparty.net/socket.io/?clientId=' + clientId + '&shard=' + shardNum + '&EIO=4&transport=websocket';

                    try {
                        var ws = new WebSocket(wsUrl);
                        var resolved = false;

                        var timeout = setTimeout(function () {
                            if (!resolved) {
                                try { ws.close(); } catch (e) {}
                                callback(null);
                            }
                        }, 7000);

                        ws.onmessage = function (event) {
                            var msg = event.data;
                            if (typeof msg !== 'string') return;

                            if (msg.indexOf('0{') === 0) {
                                ws.send('40/' + roomId + ',');
                            } else if (msg.indexOf('40/' + roomId) === 0) {
                                var payload = ['CMD:host', {
                                    video: 'moviecdn://' + kpId,
                                    source: sourceName,
                                    translation: translationId.toString()
                                }];
                                ws.send('42/' + roomId + ',' + JSON.stringify(payload));
                            } else if (msg.indexOf('REC:host') !== -1) {
                                try {
                                    var jsonStr = msg.substring(msg.indexOf('["REC:host",') + 12);
                                    if (jsonStr.indexOf(',"Q') !== -1) {
                                        jsonStr = jsonStr.substring(0, jsonStr.lastIndexOf(',"Q'));
                                    } else if (jsonStr.charAt(jsonStr.length - 1) === ']') {
                                        jsonStr = jsonStr.substring(0, jsonStr.length - 1);
                                    }
                                    var hostData = JSON.parse(jsonStr);
                                    if (hostData && hostData.movieSourceURL) {
                                        resolved = true;
                                        clearTimeout(timeout);
                                        try { ws.close(); } catch (e) {}

                                        var finalUrl = buildPlayerUrl(hostData.movieSourceURL, sourceName, kpId, translationId);
                                        callback(finalUrl);
                                    }
                                } catch (err) {
                                    console.error('[WParty] Host parse error:', err);
                                }
                            }
                        };

                        ws.onerror = function () {
                            if (!resolved) {
                                clearTimeout(timeout);
                                callback(null);
                            }
                        };
                    } catch (e) {
                        callback(null);
                    }
                }, function () {
                    callback(null);
                });
            }, function () {
                callback(null);
            }, JSON.stringify({ roomType: 'public', title: 'LampaRoom' }), {
                headers: { 'Content-Type': 'application/json' },
                contentType: 'application/json; charset=UTF-8',
                dataType: 'json'
            });
        }

        function buildPlayerUrl(sourceUrl, sourceName, kpId, translationId) {
            if (!sourceUrl) return '';

            switch (sourceName) {
                case 'alloha':
                    var sepA = sourceUrl.indexOf('?') !== -1 ? '&' : '?';
                    return sourceUrl + sepA + 'kp=' + kpId + '&hidden=translation&translation=' + translationId + '&autoplay=1&auto=1';

                case 'turbo':
                    if (sourceUrl.indexOf('/embed/') !== -1) {
                        var sepT = sourceUrl.indexOf('?') !== -1 ? '&' : '?';
                        return sourceUrl + sepT + 'autoplay=1&auto=1';
                    }
                    return sourceUrl + '/kinopoisk/' + kpId + '?api=1&autoplay=1&auto=1';

                case 'vibix':
                    if (sourceUrl.indexOf('http') === 0) {
                        return sourceUrl + '/embed-kp/' + kpId + '?voiceover=' + translationId + '!&autoplay=1';
                    }
                    var html = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
                        '<style>html,body,#playerContainer,iframe{width:100% !important;height:100% !important;margin:0;padding:0;background:#000;border:none;overflow:hidden;}</style>' +
                        '</head><body><div id="playerContainer">' +
                        '<ins data-publisher-id="' + sourceUrl + '" data-type="kp" data-id="' + kpId + '" data-voiceover="' + translationId + '" data-voiceover-only="true" data-noads="true" data-autoplay="true" data-max-wait="3000"></ins>' +
                        '</div><script type="text/javascript" src="https://graphicslab.io/sdk/v2/rendex-sdk.min.js"><\/script></body></html>';
                    try {
                        var blob = new Blob([html], { type: 'text/html' });
                        return URL.createObjectURL(blob);
                    } catch (e) {
                        return 'https://vibix.org/embed-kp/' + kpId + '?voiceover=' + translationId + '!';
                    }

                case 'kodik':
                    return sourceUrl + '/find-player?kinopoiskID=' + kpId + '&translations=false&onlyTranslationID=[' + translationId + ']&autoplay=1';

                case 'videocdn':
                case 'lumex':
                    var sepV = sourceUrl.indexOf('?') !== -1 ? '&' : '?';
                    return sourceUrl + sepV + 'kp_id=' + kpId + '&start_time=0&autoplay=1';

                default:
                    var sepD = sourceUrl.indexOf('?') !== -1 ? '&' : '?';
                    return sourceUrl + sepD + 'kp_id=' + kpId + '&start_time=0&translation=' + translationId + '&autoplay=1';
            }
        }

        function playInIframe(streamUrl, title) {
            if (Lampa.Iframe && Lampa.Iframe.show) {
                var iframeEl = Lampa.Iframe.render().find('iframe');
                iframeEl.attr('allow', 'autoplay *; fullscreen *; encrypted-media *; picture-in-picture *');
                iframeEl.attr('allowfullscreen', 'true');
                iframeEl.attr('webkitallowfullscreen', 'true');
                iframeEl.attr('mozallowfullscreen', 'true');
                iframeEl.attr('referrerpolicy', 'no-referrer-when-downgrade');

                function sendIframeMsg(msg) {
                    try {
                        if (iframeEl[0] && iframeEl[0].contentWindow) {
                            iframeEl[0].contentWindow.postMessage(msg, '*');
                        }
                    } catch (e) {}
                }

                iframeEl.off('load.wparty').on('load.wparty', function () {
                    try {
                        iframeEl.focus();
                        if (iframeEl[0] && iframeEl[0].contentWindow) {
                            iframeEl[0].contentWindow.focus();
                        }
                    } catch (e) {}
                    setTimeout(function () {
                        sendIframeMsg({ api: 'play' });
                        sendIframeMsg({ type: 'play' });
                        sendIframeMsg({ event: 'play' });
                    }, 500);
                });

                Lampa.Iframe.show({
                    url: streamUrl,
                    onBack: function () {
                        Lampa.Controller.toggle('content');
                    }
                });

                // Enhance Controller for iframe remote control
                if (Lampa.Controller && Lampa.Controller.add) {
                    Lampa.Controller.add('iframe', {
                        toggle: function () {
                            try {
                                iframeEl.focus();
                                if (iframeEl[0] && iframeEl[0].contentWindow) {
                                    iframeEl[0].contentWindow.focus();
                                }
                            } catch (e) {}
                        },
                        enter: function () {
                            sendIframeMsg({ api: 'play' });
                            sendIframeMsg({ type: 'play' });
                        },
                        play_pause: function () {
                            sendIframeMsg({ api: 'play' });
                            sendIframeMsg({ type: 'play' });
                        },
                        back: function () {
                            Lampa.Iframe.close();
                        }
                    });
                    Lampa.Controller.toggle('iframe');
                }
            } else {
                Lampa.Player.play({
                    title: title,
                    url: streamUrl
                });
            }
        }

        function startWParty(movie) {
            var title = movie.title || movie.name;
            var year = (movie.release_date || movie.first_air_date || '').slice(0, 4);

            Lampa.Noty.show('Поиск на WParty: ' + title);

            searchWParty(title, year, function (found) {
                if (!found || !found.id) {
                    Lampa.Noty.show('WParty: фильм не найден');
                    return;
                }

                var kpId = found.id;
                Lampa.Noty.show('Проверка источников WParty...');

                checkSources(kpId, function (sources) {
                    if (!sources || sources.length === 0) {
                        Lampa.Noty.show('WParty: нет доступных источников');
                        return;
                    }

                    var items = [];
                    sources.forEach(function (src) {
                        var sourceTitle = src.name.toUpperCase();
                        if (src.name === 'alloha') sourceTitle = 'AllohaTV';
                        if (src.name === 'turbo') sourceTitle = 'Turbo';
                        if (src.name === 'vibix') sourceTitle = 'Vibix';
                        if (src.name === 'kodik') sourceTitle = 'Kodik';

                        if (src.translations && src.translations.length > 0) {
                            src.translations.forEach(function (tr) {
                                items.push({
                                    title: (tr.title || 'Оригинал') + ' (' + sourceTitle + ')',
                                    subtitle: 'WParty • Без рекламы',
                                    source: src.name,
                                    translation: tr.id,
                                    kpId: kpId
                                });
                            });
                        } else {
                            items.push({
                                title: sourceTitle + ' (Основной поток)',
                                subtitle: 'WParty • Без рекламы',
                                source: src.name,
                                translation: 0,
                                kpId: kpId
                            });
                        }
                    });

                    Lampa.Select.show({
                        title: 'WParty - Выберите озвучку',
                        items: items,
                        onSelect: function (selected) {
                            Lampa.Noty.show('Запуск ' + selected.title + '...');
                            resolveStream(selected.kpId, selected.source, selected.translation, function (streamUrl) {
                                if (!streamUrl) {
                                    Lampa.Noty.show('Ошибка получения видеопотока');
                                    return;
                                }

                                playInIframe(streamUrl, title + ' - ' + selected.title);
                            });
                        },
                        onBack: function () {
                            Lampa.Controller.toggle('content');
                        }
                    });
                });
            });
        }

        function addWPartyButton(e) {
            if (!e || !e.data || !e.data.movie) return;

            var render = e.object.activity.render();
            if (render.find('.view--wparty').length) return;

            var btn = $(
                '<div class="full-start__button selector view--wparty" data-subtitle="WParty • Без рекламы">' +
                    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                        '<polygon points="5 3 19 12 5 21 5 3"></polygon>' +
                    '</svg>' +
                    '<span>WParty</span>' +
                '</div>'
            );

            btn.on('hover:enter click', function () {
                startWParty(e.data.movie);
            });

            // Insert strictly into .buttons--container so it appears exclusively inside the "Смотреть" menu
            var buttonsContainer = render.find('.buttons--container');
            if (buttonsContainer.length) {
                var torrentBtn = buttonsContainer.find('.view--torrent');
                if (torrentBtn.length) {
                    torrentBtn.after(btn);
                } else {
                    buttonsContainer.append(btn);
                }
                if (e.object && e.object.activity && e.object.activity.emit) {
                    e.object.activity.emit('groupButtons');
                }
            }
        }

        Lampa.Listener.follow('full', function (e) {
            if (e.type === 'complite') {
                addWPartyButton(e);
            }
        });

        console.log('[WParty] Plugin started successfully.');
    }

    if (window.appready) {
        startPlugin();
    } else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') {
                startPlugin();
            }
        });
    }
})();
