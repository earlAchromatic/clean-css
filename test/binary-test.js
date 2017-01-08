var vows = require('vows');
var assert = require('assert');
var exec = require('child_process').exec;
var fs = require('fs');
var http = require('http');
var httpProxy = require('http-proxy');
var path = require('path');
var url = require('url');
var SourceMapConsumer = require('source-map').SourceMapConsumer;

var isWindows = process.platform == 'win32';
var lineBreakRegExp = new RegExp(require('os').EOL, 'g');

var binaryContext = function (options, context) {
  if (isWindows)
    return {};

  context.topic = function () {
    // We add __DIRECT__=1 to force binary into 'non-piped' mode
    exec('__DIRECT__=1 ./bin/cleancss ' + options, this.callback);
  };
  return context;
};

var pipedContext = function (css, options, context) {
  if (isWindows)
    return {};

  context.topic = function () {
    exec('echo "' + css + '" | ./bin/cleancss ' + options, this.callback);
  };
  return context;
};

var unixOnlyContext = function (context) {
  return isWindows ? {} : context;
};

var readFile = function (filename) {
  return fs.readFileSync(filename, { encoding: 'utf-8' }).replace(lineBreakRegExp, '');
};

var deleteFile = function (filename) {
  if (isWindows)
    exec('del /q /f ' + filename);
  else
    exec('rm ' + filename);
};

vows.describe('./bin/cleancss')
  .addBatch({
    'no options': binaryContext('', {
      'should output help': function (stdout) {
        assert.match(stdout, /Usage[:]/);
      }
    })
  })
  .addBatch({
    'help': binaryContext('-h', {
      'should output help': function (error, stdout) {
        assert.match(stdout, /Usage[:]/);
      },
      'should output one file example': function (error, stdout) {
        assert.include(stdout, 'cleancss -o one-min.css one.css');
      },
      'should output multiple files example': function (error, stdout) {
        assert.include(stdout, 'cleancss -o merged-and-minified.css one.css two.css three.css');
      },
      'should output gzipping multiple files example': function (error, stdout) {
        assert.include(stdout, 'cleancss one.css two.css three.css | gzip -9 -c > merged-minified-and-gzipped.css.gz');
      }
    })
  })
  .addBatch({
    'version': binaryContext('-v', {
      'should output help': function (error, stdout) {
        var version = JSON.parse(fs.readFileSync('./package.json')).version;
        assert.equal(stdout, version + '\n');
      }
    })
  })
  .addBatch({
    'stdin': pipedContext('a{color: #f00}', '', {
      'should output data': function (error, stdout) {
        assert.equal(stdout, 'a{color:red}');
      }
    })
  })
  .addBatch({
    'beautify': pipedContext('a{color: #f00}', '--beautify', {
      'outputs right styles': function (error, stdout) {
        assert.equal(stdout, 'a {\n  color: red\n}');
      }
    })
  })
  .addBatch({
    'strip all but first comment': pipedContext('/*!1st*//*! 2nd */a{display:block}', '-O1 specialComments:1', {
      'should keep the 2nd comment': function (error, stdout) {
        assert.equal(stdout, '/*!1st*/a{display:block}');
      }
    })
  })
  .addBatch({
    'strip all comments': pipedContext('/*!1st*//*! 2nd */a{display:block}', '-O1 specialComments:0', {
      'should keep the 2nd comment': function (error, stdout) {
        assert.equal(stdout, 'a{display:block}');
      }
    })
  })
  .addBatch({
    'piped with debug info': pipedContext('a{color: #f00;}', '-d', {
      'should output content to stdout and debug info to stderr': function (error, stdout, stderr) {
        assert.equal(stdout, 'a{color:red}');
        assert.notEqual(stderr, '');
        assert.include(stderr, 'Time spent:');
        assert.include(stderr, 'Original: 16 bytes');
        assert.include(stderr, 'Minified: 12 bytes');
        assert.include(stderr, 'Efficiency: 25%');
      }
    })
  })
  .addBatch({
    'piped with debug info on inlining 123': pipedContext('@import url(test/fixtures/imports-min.css);', '-d', {
      'should output inlining info': function (error, stdout, stderr) {
        assert.include(stderr, path.join(process.cwd(), 'test/fixtures/imports-min.css'));
      }
    })
  })
  .addBatch({
    'piped with correct debug info on inlining': pipedContext('@import url(test/fixtures/imports.css);', '-d', {
      'should output correct info': function (error, stdout, stderr) {
        assert.include(stderr, 'Original: 339 bytes');
        assert.include(stderr, 'Minified: 86 bytes');
        assert.include(stderr, 'Efficiency: 74.63%');
      }
    })
  })
  .addBatch({
    'to output file with debug info': pipedContext('a{color: #f00;}', '-d -o debug.css', {
      'should output nothing to stdout and debug info to stderr': function (error, stdout, stderr) {
        assert.isEmpty(stdout);
        assert.notEqual(stderr, '');
        assert.include(stderr, 'Time spent:');
        assert.include(stderr, 'Original: 16 bytes');
        assert.include(stderr, 'Minified: 12 bytes');
        assert.include(stderr, 'Efficiency: 25%');
      },
      'should output content to file': function () {
        var minimized = readFile('debug.css');
        assert.equal(minimized, 'a{color:red}');
      },
      teardown: function () {
        deleteFile('debug.css');
      }
    })
  })
  .addBatch({
    'skip level 2 optimizations': pipedContext('a{color:red}p{color:red}', '-O1', {
      'should do basic optimizations only': function (error, stdout) {
        assert.equal(stdout, 'a{color:red}p{color:red}');
      }
    })
  })
  .addBatch({
    'enable restructuring optimizations': pipedContext('div{margin-top:0}.one{margin:0}.two{display:block;margin-top:0}', '-O2 restructuring:on', {
      'should do basic optimizations only': function (error, stdout) {
        assert.equal(stdout, '.two,div{margin-top:0}.one{margin:0}.two{display:block}');
      }
    })
  })
  .addBatch({
    'no relative to path': binaryContext('./fixtures/partials-absolute/base.css', {
      'should not be able to resolve it fully': function (error, stdout, stderr) {
        assert.isEmpty(stdout);
        assert.notEqual(error, null);
        assert.notEqual(stderr, '');
      }
    })
  })
  .addBatch({
    'from source': binaryContext('-O2 ./test/fixtures/reset.css', {
      'should minimize': function (error, stdout) {
        var minimized = fs.readFileSync('./test/fixtures/reset-min.css', 'utf-8').replace(lineBreakRegExp, '');
        assert.equal(stdout, minimized);
      }
    })
  })
  .addBatch({
    'from multiple sources': binaryContext('./test/fixtures/partials/one.css ./test/fixtures/partials/five.css', {
      'should minimize all': function (error, stdout) {
        assert.equal(stdout, '.one{color:red}.five{background:url(data:image/jpeg;base64,/9j/)}');
      }
    })
  })
  .addBatch({
    'to file': binaryContext('-O2 -o ./reset1-min.css ./test/fixtures/reset.css', {
      'should give no output': function (error, stdout) {
        assert.isEmpty(stdout);
      },
      'should minimize': function () {
        var preminified = readFile('./test/fixtures/reset-min.css');
        var minified = readFile('./reset1-min.css');
        assert.equal(minified, preminified);
      },
      teardown: function () {
        deleteFile('./reset1-min.css');
      }
    })
  })
  .addBatch({
    'disable @import': binaryContext('--inline none ./test/fixtures/imports.css', {
      'should disable the import processing': function (error, stdout) {
        assert.equal(stdout, '@import url(test/fixtures/partials/one.css);@import url(test/fixtures/partials/two.css);.imports{color:#000}');
      }
    })
  })
  .addBatch({
    'disable all @import': pipedContext('@import url(http://127.0.0.1/remote.css);@import url(test/fixtures/partials/one.css);', '--inline none', {
      'keeps original import rules': function (error, stdout) {
        assert.equal(stdout, '@import url(http://127.0.0.1/remote.css);@import url(test/fixtures/partials/one.css);');
      }
    }),
    'disable remote @import': pipedContext('@import url(http://127.0.0.1/remote.css);@import url(test/fixtures/partials/one.css);', '--inline !remote', {
      'keeps remote import rule': function (error, stdout) {
        assert.equal(stdout, '@import url(http://127.0.0.1/remote.css);.one{color:red}');
      }
    }),
    'disable remote @import as default': pipedContext('@import url(http://127.0.0.1/remote.css);@import url(test/fixtures/partials/one.css);', '', {
      'keeps remote import rule': function (error, stdout) {
        assert.equal(stdout, '@import url(http://127.0.0.1/remote.css);.one{color:red}');
      }
    }),
    'disable remote @import by host': pipedContext('@import url(http://127.0.0.1/remote.css);@import url(test/fixtures/partials/one.css);', '--inline !127.0.0.1', {
      'keeps remote import rule': function (error, stdout) {
        assert.equal(stdout, '@import url(http://127.0.0.1/remote.css);.one{color:red}');
      }
    })
  })
  .addBatch({
    'relative image paths': {
      'no output': binaryContext('./test/fixtures/partials-relative/base.css', {
        'should leave paths': function (error, stdout) {
          assert.equal(stdout, 'a{background:url(test/fixtures/partials/extra/down.gif) 0 0 no-repeat}');
        }
      }),
      'output': binaryContext('-o ./base1-min.css ./test/fixtures/partials-relative/base.css', {
        'should rewrite path relative to current path': function () {
          var minimized = readFile('./base1-min.css');
          assert.equal(minimized, 'a{background:url(test/fixtures/partials/extra/down.gif) 0 0 no-repeat}');
        },
        teardown: function () {
          deleteFile('./base1-min.css');
        }
      }),
      'piped with output': pipedContext('a{background:url(test/fixtures/partials/extra/down.gif)}', '-o base3-min.css', {
        'should keep paths as they are': function () {
          var minimized = readFile('base3-min.css');
          assert.equal(minimized, 'a{background:url(test/fixtures/partials/extra/down.gif)}');
        },
        teardown: function () {
          deleteFile('base3-min.css');
        }
      })
    }
  })
  .addBatch({
    'import rebasing': binaryContext('test/fixtures/partials/quoted-svg.css', {
      'should keep quoting intact': function (error, stdout) {
        assert.include(stdout, 'div{background:url("data:image');
        assert.include(stdout, 'svg%3E")}');
      }
    })
  })
  .addBatch({
    'complex import and url rebasing': {
      'absolute': binaryContext('./test/fixtures/129-assets/assets/ui.css', {
        'should rebase urls correctly': function (error, stdout) {
          assert.include(stdout, 'url(test/fixtures/129-assets/components/bootstrap/images/glyphs.gif)');
          assert.include(stdout, 'url(test/fixtures/129-assets/components/jquery-ui/images/prev.gif)');
          assert.include(stdout, 'url(test/fixtures/129-assets/components/jquery-ui/images/next.gif)');
        }
      }),
      'relative': binaryContext('-o test/ui.bundled.css ./test/fixtures/129-assets/assets/ui.css', {
        'should rebase urls correctly': function () {
          var minimized = readFile('test/ui.bundled.css');
          assert.include(minimized, 'url(fixtures/129-assets/components/bootstrap/images/glyphs.gif)');
          assert.include(minimized, 'url(fixtures/129-assets/components/jquery-ui/images/prev.gif)');
          assert.include(minimized, 'url(fixtures/129-assets/components/jquery-ui/images/next.gif)');
        },
        teardown: function () {
          deleteFile('test/ui.bundled.css');
        }
      })
    }
  })
  .addBatch({
    'complex import and skipped url rebasing': {
      'absolute': binaryContext('--skip-rebase ./test/fixtures/129-assets/assets/ui.css', {
        'should rebase urls correctly': function (error, stdout) {
          assert.isNull(error);
          assert.include(stdout, 'url(../images/glyphs.gif)');
          assert.include(stdout, 'url(../images/prev.gif)');
          assert.include(stdout, 'url(../images/next.gif)');
        }
      })
    }
  })
  .addBatch({
    'remote import': {
      topic: function () {
        this.server = http.createServer(function (req, res) {
          res.writeHead(200);
          res.end('p{font-size:13px}');
        }).listen(31991, '127.0.0.1');

        this.callback(null);
      },
      'of a file': binaryContext('http://127.0.0.1:31991/present.css', {
        succeeds: function (error, stdout) {
          assert.isNull(error);
          assert.equal(stdout, 'p{font-size:13px}');
        }
      }),
      teardown: function () {
        this.server.close();
      }
    }
  })
  .addBatch({
    'timeout': unixOnlyContext({
      topic: function () {
        var self = this;
        var source = '@import url(http://localhost:24682/timeout.css);';

        this.server = http.createServer(function () {
          setTimeout(function () {}, 1000);
        });
        this.server.listen('24682', function () {
          exec('echo "' + source + '" | ./bin/cleancss --inline all --inline-timeout 0.01', self.callback);
        });
      },
      'should raise warning': function (error, stdout, stderr) {
        assert.include(stderr, 'Broken @import declaration of "http://localhost:24682/timeout.css" - timeout');
      },
      'should output empty response': function (error, stdout) {
        assert.isEmpty(stdout);
      },
      teardown: function () {
        this.server.close();
      }
    })
  })
  .addBatch({
    'HTTP proxy': unixOnlyContext({
      topic: function () {
        var self = this;
        this.proxied = false;

        var proxy = httpProxy.createProxyServer();
        this.proxyServer = http.createServer(function (req, res) {
          self.proxied = true;
          proxy.web(req, res, { target: 'http://' + url.parse(req.url).host }, function () {});
        });
        this.proxyServer.listen(8081);

        this.server = http.createServer(function (req, res) {
          res.writeHead(200);
          res.end('a{color:red}');
        });
        this.server.listen(8080);

        exec('echo "@import url(http://127.0.0.1:8080/test.css);" | HTTP_PROXY=http://127.0.0.1:8081 ./bin/cleancss --inline all', this.callback);
      },
      'proxies the connection': function () {
        assert.isTrue(this.proxied);
      },
      'gives right output': function (error, stdout) {
        assert.equal(stdout, 'a{color:red}');
      },
      teardown: function () {
        this.proxyServer.close();
        this.server.close();
      }
    })
  })
  .addBatch({
    'ie7 compatibility': binaryContext('--compatibility ie7 ./test/fixtures/unsupported/selectors-ie7.css', {
      'should not transform source': function (error, stdout) {
        assert.equal(stdout, readFile('./test/fixtures/unsupported/selectors-ie7.css'));
      }
    })
  })
  .addBatch({
    'ie8 compatibility': binaryContext('--compatibility ie8 ./test/fixtures/unsupported/selectors-ie8.css', {
      'should not transform source': function (error, stdout) {
        assert.equal(stdout, readFile('./test/fixtures/unsupported/selectors-ie8.css'));
      }
    })
  })
  .addBatch({
    'custom compatibility': pipedContext('a{_color:red}', '--compatibility "+properties.iePrefixHack"', {
      'should not transform source': function (error, stdout) {
        assert.equal(stdout, 'a{_color:red}');
      }
    })
  })
  .addBatch({
    'rounding precision': {
      'default': pipedContext('div{width:0.10051px}', '', {
        'should keep 2 decimal places': function (error, stdout) {
          assert.equal(stdout, 'div{width:.10051px}');
        }
      }),
      'custom': pipedContext('div{width:0.00051px}', '-O1 roundingPrecision:4', {
        'should keep 4 decimal places': function (error, stdout) {
          assert.equal(stdout, 'div{width:.0005px}');
        }
      }),
      'zero': pipedContext('div{width:1.5051px}', '-O1 roundingPrecision:0', {
        'should keep 0 decimal places': function (error, stdout) {
          assert.equal(stdout, 'div{width:2px}');
        }
      }),
      'disabled': pipedContext('div{width:0.12345px}', '-O1 roundingPrecision:off', {
        'should keep all decimal places': function (error, stdout) {
          assert.equal(stdout, 'div{width:.12345px}');
        }
      }),
      'disabled via -1': pipedContext('div{width:0.12345px}', '-O1 roundingPrecision:\\\\-1', {
        'should keep all decimal places': function (error, stdout) {
          assert.equal(stdout, 'div{width:.12345px}');
        }
      }),
      'fine-grained': pipedContext('div{height:10.515rem;width:12.12345px}', '-O1 roundingPrecision:rem=2,px=1', {
        'should keep all decimal places': function (error, stdout) {
          assert.equal(stdout, 'div{height:10.52rem;width:12.1px}');
        }
      })
    }
  })
  .addBatch({
    'neighbour merging': {
      'of (yet) unmergeable properties': pipedContext('a{display:inline-block;color:red;display:-moz-block}', '-O2 --skip-aggressive-merging', {
        'gets right result': function (error, stdout) {
          assert.equal(stdout, 'a{display:inline-block;color:red;display:-moz-block}');
        }
      }),
      'of mergeable properties': pipedContext('a{background:red;display:block;background:white}', '-O2 --skip-aggressive-merging', {
        'gets right result': function (error, stdout) {
          assert.equal(stdout, 'a{background:#fff;display:block}');
        }
      })
    }
  })
  .addBatch({
    '@media merging': pipedContext('@media screen{a{color:red}}@media screen{a{display:block}}', '-O2 mediaMerging:off', {
      'gets right result': function (error, stdout) {
        assert.equal(stdout, '@media screen{a{color:red}}@media screen{a{display:block}}');
      }
    })
  })
  .addBatch({
    'shorthand compacting': {
      'of (yet) unmergeable properties': pipedContext('a{background:url(image.png);background-color:red}', '-O2 shorthandCompacting:off', {
        'gets right result': function (error, stdout) {
          assert.equal(stdout, 'a{background:url(image.png);background-color:red}');
        }
      })
    }
  })
  .addBatch({
    'source maps - no target file': binaryContext('--source-map ./test/fixtures/reset.css', {
      'warns about source map not being build': function (error, stdout, stderr) {
        assert.include(stderr, 'Source maps will not be built because you have not specified an output file.');
      },
      'does not include map in stdout': function (error, stdout) {
        assert.notInclude(stdout, '/*# sourceMappingURL');
      }
    })
  })
  .addBatch({
    'source maps - output file': binaryContext('--source-map -o ./reset.min.css ./test/fixtures/reset.css', {
      'includes map in minified file': function () {
        assert.include(readFile('./reset.min.css'), '/*# sourceMappingURL=reset.min.css.map */');
      },
      'creates a map file': function () {
        assert.isTrue(fs.existsSync('./reset.min.css.map'));
      },
      'includes right content in map file': function () {
        var sourceMap = new SourceMapConsumer(readFile('./reset.min.css.map'));
        assert.deepEqual(
          sourceMap.originalPositionFor({ line: 1, column: 1 }),
          {
            source: 'test/fixtures/reset.css',
            line: 4,
            column: 0,
            name: null
          }
        );
      },
      'teardown': function () {
        deleteFile('reset.min.css');
        deleteFile('reset.min.css.map');
      }
    })
  })
  .addBatch({
    'source maps - output file in same folder as input': unixOnlyContext({
      topic: function () {
        var self = this;

        exec('cp test/fixtures/reset.css .', function () {
          exec('__DIRECT__=1 ./bin/cleancss --source-map -o ./reset.min.css ./reset.css', self.callback);
        });
      },
      'includes right content in map file': function () {
        var sourceMap = new SourceMapConsumer(readFile('./reset.min.css.map'));
        assert.deepEqual(
          sourceMap.originalPositionFor({ line: 1, column: 1 }),
          {
            source: 'reset.css',
            line: 4,
            column: 0,
            name: null
          }
        );
      },
      'teardown': function () {
        deleteFile('reset.css');
        deleteFile('reset.min.css');
        deleteFile('reset.min.css.map');
      }
    })
  })
  .addBatch({
    'source maps - output file with existing map': binaryContext('--source-map -o ./styles.min.css ./test/fixtures/source-maps/styles.css', {
      'includes right content in map file': function () {
        var sourceMap = new SourceMapConsumer(readFile('./styles.min.css.map'));
        assert.deepEqual(
          sourceMap.originalPositionFor({ line: 1, column: 1 }),
          {
            source: 'test/fixtures/source-maps/styles.less',
            line: 1,
            column: 4,
            name: null
          }
        );
      },
      'teardown': function () {
        deleteFile('styles.min.css');
        deleteFile('styles.min.css.map');
      }
    })
  })
  .addBatch({
    'source maps - output file for existing map in different folder': binaryContext('--source-map -o ./styles-relative.min.css ./test/fixtures/source-maps/relative.css', {
      'includes right content in map file': function () {
        var sourceMap = new SourceMapConsumer(readFile('./styles-relative.min.css.map'));
        assert.deepEqual(
          sourceMap.originalPositionFor({ line: 1, column: 1 }),
          {
            source: 'test/fixtures/source-maps/sub/styles.less',
            line: 2,
            column: 2,
            name: null
          }
        );
      },
      'teardown': function () {
        deleteFile('styles-relative.min.css');
        deleteFile('styles-relative.min.css.map');
      }
    })
  })
  .addBatch({
    'source maps - with input source map': binaryContext('--source-map -o ./import.min.css ./test/fixtures/source-maps/import.css', {
      'includes map in minified file': function () {
        assert.include(readFile('./import.min.css'), '/*# sourceMappingURL=import.min.css.map */');
      },
      'includes right content in map file': function () {
        var sourceMap = new SourceMapConsumer(readFile('./import.min.css.map'));
        var count = 0;
        sourceMap.eachMapping(function () { count++; });

        assert.equal(count, 6);
      },
      'teardown': function () {
        deleteFile('import.min.css');
        deleteFile('import.min.css.map');
      }
    })
  })
  .addBatch({
    'source maps - with input source map and source inlining': binaryContext('--source-map --source-map-inline-sources -o ./import-inline.min.css ./test/fixtures/source-maps/import.css', {
      'includes map in minified file': function () {
        assert.include(readFile('./import-inline.min.css'), '/*# sourceMappingURL=import-inline.min.css.map */');
      },
      'includes embedded sources': function () {
        var sourceMap = new SourceMapConsumer(readFile('./import-inline.min.css.map'));
        var count = 0;
        sourceMap.eachMapping(function () { count++; });

        assert.equal(count, 6);
      },
      'teardown': function () {
        deleteFile('import-inline.min.css');
        deleteFile('import-inline.min.css.map');
      }
    })
  })
  .addBatch({
    'semantic merging': {
      'disabled': pipedContext('.a{margin:0}.b{margin:10px;padding:0}.c{margin:0}', '', {
        'should output right data': function (error, stdout) {
          assert.equal(stdout, '.a{margin:0}.b{margin:10px;padding:0}.c{margin:0}');
        }
      }),
      'enabled': pipedContext('.a{margin:0}.b{margin:10px;padding:0}.c{margin:0}', '-O2 semanticMerging:on', {
        'should output right data': function (error, stdout) {
          assert.equal(stdout, '.a,.c{margin:0}.b{margin:10px;padding:0}');
        }
      })
    }
  })
  .export(module);
