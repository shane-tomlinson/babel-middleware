var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var babel = require('babel-core');
var micromatch = require('micromatch');

function lastModifiedHash(path, stats) {
    var mtime = stats.mtime.getTime();

    return crypto
        .createHash('md5')
        .update(mtime + '-' + path)
        .digest('hex');
}

module.exports = function(options) {
    options = options || {};

    var srcPath = options.srcPath;
    var cachePath = options.cachePath || 'memory';
    var isMemoryCache = cachePath === 'memory';
    var exclude = options.exclude || [];
    var debug = options.debug || false;
    var webConsoleErrors = options.consoleErrors || false;

    // filename to last known hash map
    var hashMap = {};

    // hash to transpiled file contents map
    var jsCacheMap = {};

    // map file cache.
    var mapCacheMap = {};

    if (!isMemoryCache) {
        try {
            fs.mkdirSync(cachePath);
        } catch (e) {}
    }

    var babelOptions = options.babelOptions || { presets: [] };

    babelOptions.highlightCode = false;

    function log() {
        if (debug) {
            console.log.apply(undefined, arguments);
        }
    }

    function handleError(res, error) {
        if (webConsoleErrors) {
            var errOutput = String(error).replace(/\'/g, '\\\'').replace(/\"/g, '\\\"');

            res.send(
                '/* Babel parsing error from babel-middleware */' +
                '\n /* See error console output for details. */' +
                '\n var output = ' + JSON.stringify(error) +
                '\n console.error("' + errOutput + '", output.codeFrame)'
            );
        } else {
            res.status(500).send(error);
        }

        res.end();
    }

    function pathForHash(hash, extension) {
        return path.resolve(cachePath + '/' + hash + extension);
    }

    return function(req, res, next) {
        if (/\.map$/.test(req.path)) {
          var mapFile = mapCacheMap[req.path];
          if (mapFile) {
              res.append('Content-Type', 'application/json');
              res.append('X-Babel-Cache', true);
              res.write(mapFile);
              res.end();
          } else {
              next();
          }

          return;
        }

        var src = path.resolve(srcPath + '/' + req.path); // XXX Need the correct path

        var stats;
        try {
            stats = fs.lstatSync(src);
        } catch(e) {
            // file not found, try the next!
            next();
            return;
        }

        if (! stats || ! stats.isFile()) {
            // not a file, next!
            next();
            return;
        }

        var hash = lastModifiedHash(src, stats);
        var lastKnownHash = hashMap[src];
        var hashPath;

        if (exclude.length) {
            if (micromatch.any(req.path.replace(/^\/+|\/+$/g, ''), exclude)) {
                log('Excluded: %s (%s)', req.path, exclude);
                res.append('X-Babel-Cache', false);
                res.sendFile(src, {}, function(err) {
                    if (err) {
                        handleError(res, err);
                    }
                });
                return;
            }
        }

        log('Preparing: %s (%s)', src, hash);

        res.append('X-Babel-Cache', true);
        res.append('X-Babel-Cache-Hash', hash);

        if (!isMemoryCache) {
            hashPath = pathForHash(hash, '.js');
            try {
                fs.statSync(hashPath);
                hashMap[src] = lastKnownHash = hash;
            } catch(e) {}
        }

        if (lastKnownHash && lastKnownHash === hash) {
            // file unchanged, exit early
            var cacheMiss = false;
            if (!isMemoryCache) {
                try {
                    fs.lstatSync(hashPath);
                } catch(e) {
                    cacheMiss = true;
                }

                // Ensure Cache directory exists
                if (cacheMiss) {
                    try {
                        fs.lstatSync(cachePath);
                    } catch (e) {
                        fs.mkdirSync(cachePath);
                    }
                }
            }

            if (!cacheMiss) {
                res.append('X-Babel-Cache-Hit', true);
                if (isMemoryCache) {
                    log('Serving (cached): %s', src);
                    res.write(jsCacheMap[hash]);
                    res.end();
                } else {
                    log('Serving (cached): %s', hashPath);
                    res.sendFile(hashPath, {}, function(err) {
                        if (err) {
                            handleError(res, err);
                        }
                    });
                }
                return;
            }
        }

        res.append('X-Babel-Cache-Hit', false);

        if (isMemoryCache && lastKnownHash && lastKnownHash in jsCacheMap) {
            delete jsCacheMap[lastKnownHash];
        } else if (!isMemoryCache && lastKnownHash) {
            try {
                fs.unlinkSync(pathForHash(lastKnownHash, '.js'));
            } catch(e) {}
        }

        var result;
        try {
            result = babel.transformFileSync(src, babelOptions);
        } catch(e) {
            handleError(res, e);
            return;
        }

        var code = result.code;
        hashMap[src] = hash;

        if (result.map) {
            // for v1, only an in-memory map cache.
            mapCacheMap[req.path + '.map'] = JSON.stringify(result.map);
            var mapFilename = path.basename(req.path) + '.map';
            code += '\n//# sourceMappingURL=' + mapFilename;
        }

        if (isMemoryCache) {
            jsCacheMap[hash] = code;
        } else {
            fs.writeFile(hashPath, code, function(err) {
                if (err) {
                    // console.error('Error saving ' + hashPath + ': ' + err);
                    delete hashMap[src];
                }
            });
        }
        log('Serving (uncached): %s', src);
        res.write(code);
        res.end();
    };
};
