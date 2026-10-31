(function () {
    'use strict';

    function startPlugin() {
        if (window.plugin_wparty_ready) return;
        window.plugin_wparty_ready = true;

        var network = new Lampa.Reguest();
        var WPARTY_API = 'https://wparty.net/api';

        // Register plugin in LAMPA manifest
        try {
            Lampa.Manifest.plugins = {
                type: 'video',
                version: '1.0.0',
                name: 'WParty (Без рекламы)',
                description: 'Онлайн просмотр без рекламы через WParty',
                component: 'wparty'
            };
        } catch (e) {}

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
                headers: { 'Content-Type': 'application/json' }
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
                headers: { 'Content-Type': 'application/json' }
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
                headers: { 'Content-Type': 'application/json' }
            });
        }

        function buildPlayerUrl(sourceUrl, sourceName, kpId, translationId) {
            switch (sourceName) {
                case 'alloha':
                    return sourceUrl + '&kp=' + kpId + '&hidden=translation&translation=' + translationId;
                case 'videocdn':
                case 'lumex':
                    return sourceUrl + '?kp_id=' + kpId + '&start_time=0';
                case 'turbo':
                    return sourceUrl + '/kinopoisk/' + kpId + '?api=1';
                case 'vibix':
                    return sourceUrl + '/embed-kp/' + kpId + '?voiceover=' + translationId + '!';
                case 'kodik':
                    return sourceUrl + '/find-player?kinopoiskID=' + kpId + '&translations=false&onlyTranslationID=[' + translationId + ']';
                default:
                    return sourceUrl + '?kp_id=' + kpId + '&start_time=0&translation=' + translationId;
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

                                Lampa.Player.play({
                                    title: title + ' - ' + selected.title,
                                    url: streamUrl
                                });
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

            var btn = $('<div class="full-start__button selector view--wparty" style="background: linear-gradient(90deg, #6c5ce7, #a29bfe); color: #fff; margin-right: 10px; font-weight: bold; border-radius: 6px; padding: 0 15px;"><span>WParty</span></div>');

            btn.on('hover:enter', function () {
                startWParty(e.data.movie);
            });

            var playBtn = render.find('.button--play, .view--play, .full-start__button').first();
            if (playBtn.length) {
                playBtn.after(btn);
            } else {
                var buttonsRow = render.find('.full-start-new__buttons, .full-start__buttons, .full-start-buttons');
                if (buttonsRow.length) {
                    buttonsRow.prepend(btn);
                } else {
                    render.find('.view--torrent').after(btn);
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
