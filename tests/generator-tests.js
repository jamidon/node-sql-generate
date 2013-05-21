var should = require('should'),
	fs = require('fs'),
	path = require('path'),
	util = require('util'),
	generate = require('../');

describe('generator', function() {
	var schema = 'node_sql_generate',
		dialects = {
			mysql: 'mysql://root:password@localhost/'
			//pg: 'tcp://root:password@localhost/' + schema
		},
		getExpected = function(name) {
			return fs.readFileSync(path.join(__dirname, 'files', 'expected', name + '.js'), 'utf8');
		},
		removeAutogeneratedComment = function(string) {
			return string.replace(/\/\/ autogenerated.+?(\r\n|\n)/, '');
		},
		options = function(options) {
			return util._extend(util._extend({}, defaults), options);
		};

	for (var dialect in dialects) {
		var dsn = dialects[dialect],
			db = require(dialect),
			//outputFile = path.join(__dirname, 'tmp', 'output.js'),
			defaults = {
				dsn: dsn,
				dialect: dialect,
				schema: schema
			},
			client;

		describe('for ' + dialect, function() {

			before(function(done) {
				function runScripts(err) {
					should.not.exist(err);
					var sql = fs.readFileSync(path.join(__dirname, 'files', dialect + '-before.sql'), 'utf8');
					client.query(sql, done);
				}

				switch (dialect) {
					case 'mysql':
						client = db.createConnection(dsn + '?multipleStatements=true');
						client.connect(runScripts);
						break;
					case 'pg':
						client = new db.Client(dsn);
						client.connect(runScripts);
						break;
				}
			});

			after(function(done) {
				function runScripts(callback) {
					var sql = fs.readFileSync(path.join(__dirname, 'files', dialect + '-after.sql'), 'utf8');
					client.query(sql, callback);
				}

				switch (dialect) {
					case 'mysql':
						runScripts(function(scriptErr) {
							client.end(function(err) {
								done(scriptErr || err);
							});
						});
						break;
					case 'pg':
						runScripts(function(scriptErr) {
							client.end();
							done(scriptErr);
						});
						break;
				}
			});

			it('with defaults', function(done) {
				generate(defaults, function(err, stats) {
					should.not.exist(err);
					var expected = getExpected('defaults');
					removeAutogeneratedComment(stats.buffer).should.equal(expected);
					done();
				});
			});

			it('with custom indentation character', function(done) {
				generate(options({ indent: '  ' }), function(err, stats) {
					should.not.exist(err);
					var expected = getExpected('indent');
					removeAutogeneratedComment(stats.buffer).should.equal(expected);
					done();
				});
			});

			it('with camel cased name', function(done) {
				generate(options({ camelize: true }), function(err, stats) {
					should.not.exist(err);
					var expected = getExpected('camelize');
					removeAutogeneratedComment(stats.buffer).should.equal(expected);
					done();
				});
			});

			it('with custom EOL character', function(done) {
				generate(options({ eol: '\r\n' }), function(err, stats) {
					should.not.exist(err);
					var expected = getExpected('eol');
					removeAutogeneratedComment(stats.buffer).should.equal(expected);
					done();
				});
			});

			it('with prepended text', function(done) {
				generate(options({ prepend: '//hello world' }), function(err, stats) {
					should.not.exist(err);
					var expected = getExpected('prepend');
					removeAutogeneratedComment(stats.buffer).should.equal(expected);
					done();
				});
			});

			it('with appended text', function(done) {
				generate(options({ append: '//hello world' }), function(err, stats) {
					should.not.exist(err);
					var expected = getExpected('append');
					removeAutogeneratedComment(stats.buffer).should.equal(expected);
					done();
				});
			});

			it('with omitted comments', function(done) {
				generate(options({ omitComments: true }), function(err, stats) {
					should.not.exist(err);
					var expected = getExpected('omit-comments');
					stats.buffer.should.equal(expected);
					done();
				});
			});
		});
	}
});