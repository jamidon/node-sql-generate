var fs = require('fs'),
	util = require('util'),
	info = require('./package.json'),
	async = require('async'),
	sql = require('sql');

var supportedDialects = {
	mysql: 1,
	pg: 1,
	mssql: 1
};

/**
 * @param {Object} options
 * @param {String} options.dialect Either "mysql", "pg" or "mssql"
 * @param {String} options.dsn The DSN to use to connect to the database
 * @param {String} options.schema The name of the schema/database to extract from
 * @param {String} [options.indent] String to use for indentation of generated code, defaults to "\t"
 * @param {String|Number} [options.outputFile] Filename to write to, or the number 1 to write to stdout
 * @param {Boolean} [options.camelize] Convert underscored names to camel case ("foo_bar" -> "fooBar")
 * @param {String} [options.eol] End-of-line character, defaults to "\n"
 * @param {String} [options.mode] The permission mode of the output file, defaults to 0644
 * @param {String} [options.encoding] The encoding of the output file, defaults to "utf8"
 * @param {String} [options.prepend] String to prepend to the beginning of the generated output
 * @param {String} [options.append] String to append to the end of the generated output
 * @param {String} [options.omitComments] Omit autogenerated comments
 * @param {String} [options.includeSchema] Include schema in definition
 * @param {String} [options.modularize] Omit require('sql') and wrap generated code in module.exports = function() {...}
 * @param {Boolean} [options.includeMeta] Add metadata to column definitions (not used by node-sql)
 * @param {function} [options.log] Logging function
 * @param {Function} [callback]
 */
module.exports = function(options, callback) {
	options = options || {};

	if (!options.dsn) {
		callback && callback(new Error('options.dsn is required'));
		return;
	}
	if (!options.dialect) {
		var match = /^(mysql|postgres|mssql)/i.exec(options.dsn);
		if (!match) {
			callback && callback(new Error('options.dialect is required'));
			return;
		}
		options.dialect = match[1].toLowerCase();
		if (options.dialect === 'postgres') {
			options.dialect = 'pg';
		}
	}

	options.dialect = options.dialect.toLowerCase();

	if (!supportedDialects[options.dialect]) {
		callback && callback(new Error('options.dialect must be either "mysql", "pg" or "mssql"'));
		return;
	}

	options.eol = options.eol || '\n';
	options.encoding = options.encoding || 'utf8';
	options.mode = options.mode || 0644;
	options.indent = options.indent || '\t';

	function camelize(name) {
		return name.replace(/_(.)/g, function(all, c) {
			return c.toUpperCase();
		});
	}

	function tryCamelize(name) {
		return !options.camelize ? name : camelize(name);
	}

	function runQuery(query, callback) {
		query = query.toQuery();
		log('debug', 'QUERY: ' + query.text + ' :: ' + util.inspect(query.values));
		switch (options.dialect) {
			case 'mysql':
				client.query(query.text, query.values, callback);
				break;
			case 'pg':
				client.query(query.text, query.values, function(err, result) {
					callback(err, result && result.rows);
				});
				break;
			case 'mssql':
				var req = client.request();

				query.values.map(function(value, index) {
					req.input(index + 1, value);
				});

				req.query(query.text, callback);
				break;
		}
	}

	function write() {
		var string = [].slice.call(arguments, 0, -1)
				.map(function(obj) { return (obj || '').toString(); })
				.filter(function(message) { return !!message; })
				.join(options.eol) + options.eol,
			callback = arguments[arguments.length - 1],
			buffer = new Buffer(string, options.encoding);

		if (fd) {
			fs.write(fd, buffer, 0, buffer.length, null, function(err, written) {
				stats.bytesWritten += (written || 0);
				callback(err);
			});
		} else {
			stats.buffer += buffer.toString();
			stats.bytesWritten += buffer.length;
			callback();
		}
	}

	function getListOfTables(callback) {
		var query = tables
			.select(tables.name.as('name'))
			.from(tables);

		switch (options.dialect) {
			case 'mysql':
				query = query.where(tables.schema.equals(options.database));
				break;
			case 'pg':
				query = query
					.where(tables.schema.equals(options.schema))
					.and(tables.catalog.equals(options.database));
				break;
			case 'mssql':
				query = query
					.where(tables.schema.equals(options.schema || 'dbo'))
					.and(tables.catalog.equals(options.database))
					.and(tables.type.equals('BASE TABLE'))
					.and(tables.name.notEquals('sysdiagrams')); //disconsider views
				break;
		}

		query = query.order(tables.name);

		runQuery(query, function(err, rows) {
			if (err) {
				callback(err);
				return;
			}
		  callback(null, rows.map(function(row) {
                    if (options.includeRegex || options.excludeRegex) {
                      if (options.includeRegex) {
                        if (options.includeRegex.some(function(re) { return row.name.match(re) !== null; })) {
			  // don't return excluded tables
			  if (options.excludeRegex &&
			      !options.excludeRegex.every(function(re) { return row.name.match(re) === null; })) {
			    return undefined;
			  } else {
			    return row.name;
			  }
                        } else {
			  return undefined;
                        }
                      } else if (options.excludeRegex) {
			if (!options.excludeRegex.every(function(re) { return row.name.match(re) === null; })) {
			  return undefined;
		        } else {
			  return row.name;
		        }
                      } else {
			return undefined;
                      }
                    } else {
		      return row.name;
		    }
		  }).filter(function(r) { return r !== undefined; }));
		});
	}

	function getListOfColumns(tableName, callback) {
		var query = columns
			.select(
				columns.name.as('name'),
				columns.isNullable.as('nullable'),
				columns.defaultValue.as('defaultValue'),
				columns.charLength.as('charLength'),
				columns.type.as('type')
			)
			.from(columns)
			.where(columns.tableName.equals(tableName));

		switch (options.dialect) {
			case 'mysql':
				query = query.and(columns.tableSchema.equals(options.database));
				break;
			case 'pg':
				query = query
					.and(columns.tableSchema.equals(options.schema))
					.and(columns.tableCatalog.equals(options.database));
				break;
			case 'mssql':
				query = query
					.and(columns.tableSchema.equals(options.schema || 'dbo'))
					.and(columns.tableCatalog.equals(options.database));
				break;
		}

		query = query.order(columns.ordinalPosition);

		runQuery(query, function(err, results) {
			if (err) {
				callback(err);
				return;
			}

			results = results.map(function(col) {
				switch (col.type) {
					case 'character varying':
						col.type = 'varchar';
						break;
					case 'character':
						col.type = 'char';
						break;
					case 'integer':
						col.type = 'int';
						break;
				}

				col.nullable = col.nullable === 'YES';
				col.maxLength = parseInt(col.maxLength) || null;

				return col;
			});

			callback(null, results);
		});
	}

	var log = options.log || function() {},
		fd = null,
		client = null,
		tableNames = null,
		stats = {
			start: new Date(),
			end: null,
			elapsed: null,
			written: 0,
			buffer: '',
			tables: {}
		},
		db = require(options.dialect),
		columns,
		tables;

	switch (options.dialect) {
		case 'mysql':
			client = db.createConnection(options.dsn);
			options.database = options.database || client.config.database;
			sql.setDialect('mysql');
			columns = sql.define({
				name: 'COLUMNS',
				schema: 'information_schema',
				columns: [
					{ name: 'TABLE_SCHEMA', property: 'tableSchema' },
					{ name: 'TABLE_NAME', property: 'tableName' },
					{ name: 'COLUMN_NAME', property: 'name' },
					{ name: 'ORDINAL_POSITION', property: 'ordinalPosition' },
					{ name: 'DATA_TYPE', property: 'type' },
					{ name: 'CHARACTER_MAXIMUM_LENGTH', property: 'charLength' },
					{ name: 'COLUMN_DEFAULT', property: 'defaultValue' },
					{ name: 'IS_NULLABLE', property: 'isNullable' }
				]
			});
			tables = sql.define({
				name: 'TABLES',
				schema: 'information_schema',
				columns: [
					{ name: 'TABLE_NAME', property: 'name' },
					{ name: 'TABLE_SCHEMA', property: 'schema' }
				]
			});
			break;
		case 'pg':
			sql.setDialect('postgres');
			client = new db.Client(options.dsn);
			options.database = options.database || client.database;
			options.schema = options.schema || 'public';
			columns = sql.define({
				name: 'columns',
				schema: 'information_schema',
				columns: [
					{ name: 'table_schema', property: 'tableSchema' },
					{ name: 'table_name', property: 'tableName' },
					{ name: 'table_catalog', property: 'tableCatalog' },
					{ name: 'column_name', property: 'name' },
					{ name: 'ordinal_position', property: 'ordinalPosition' },
					{ name: 'data_type', property: 'type' },
					{ name: 'character_maximum_length', property: 'charLength' },
					{ name: 'column_default', property: 'defaultValue' },
					{ name: 'is_nullable', property: 'isNullable' }
				]
			});
			tables = sql.define({
				name: 'tables',
				schema: 'information_schema',
				columns: [
					{ name: 'table_name', property: 'name' },
					{ name: 'table_schema', property: 'schema' },
					{ name: 'table_catalog', property: 'catalog' }
				]
			});
			break;
		case 'mssql':
			sql.setDialect('mssql');
			//Extract information from mssql dsn to options, since the mssql module do not understand the dsn format
			var mssqlDsn = options.dsn;
			if (mssqlDsn.slice(-1) === ';') {
				mssqlDsn = mssqlDsn.substring(0, mssqlDsn.length - 1);
			}
			try {
				mssqlDsn = JSON.parse("{\"" +
					mssqlDsn.replace('mssql://', '')
						.replace(/=/g, '\":\"')
						.replace(/;/g, '\",\"') +
					"\"}"
				);
			} catch (e) {
				callback(e);
				return;
			}

			client = new db.Connection(mssqlDsn);
			options.database = options.database || mssqlDsn.database;
			columns = sql.define({
				name: 'columns',
				schema: options.database + '].[information_schema',
				columns: [
					{ name: 'table_schema', property: 'tableSchema' },
					{ name: 'table_name', property: 'tableName' },
					{ name: 'table_catalog', property: 'tableCatalog' },
					{ name: 'column_name', property: 'name' },
					{ name: 'ordinal_position', property: 'ordinalPosition' },
					{ name: 'data_type', property: 'type' },
					{ name: 'character_maximum_length', property: 'charLength' },
					{ name: 'column_default', property: 'defaultValue' },
					{ name: 'is_nullable', property: 'isNullable' }
				]
			});
			tables = sql.define({
				name: 'tables',
				schema: options.database + '].[information_schema',
				columns: [
					{ name: 'table_name', property: 'name' },
					{ name: 'table_schema', property: 'schema' },
					{ name: 'table_catalog', property: 'catalog' },
					{ name: 'table_type', property: 'type' }
				]
			});
			break;
	}

	if (!options.database) {
		callback(new Error('options.database is required if it is not part of the DSN'));
		return;
	}

	function openFile(next) {
		if (typeof(options.outputFile) === 'string') {
			fs.open(options.outputFile, 'w', options.mode, function(err, descriptor) {
				if (!err) {
					fd = descriptor;
				}

				next(err);
			});
		} else {
			if (options.outputFile === 1) {
				fd = 1; //stdout
			}

			process.nextTick(next);
		}
	}

	function connect(next) {
		log('debug', 'Attempting connection with DSN "' + options.dsn + '"');
		client.connect(next);
	}

	function writeHead(next) {
		log('info',
			'Starting generation against ' + options.database +
				(options.schema ? '.' + options.schema : '')
		);

		var functions = [];
		if (options.prepend) {
			functions.push(function(next) {
				write(options.prepend + options.eol, next);
			});
		}

		if (!options.omitComments) {
			functions.push(function(next) {
				var headerComment = '// autogenerated by ' + info.name +
					' v' + info.version + ' on ' + new Date();
				write(headerComment + options.eol, next);
			});
		}

		if (options.modularize) {
			functions.push(function(next) {
				write(
					'module.exports = function(sql) {',
					options.indent + 'var exports = {};',
					options.eol,
					next
				);
			});
		} else {
			functions.push(function(next) {
				write('var sql = require(\'sql\');', options.eol, next);
			});
		}

		async.series(functions, next);
	}

	function fetchTables(next) {
		getListOfTables(function(err, tables) {
			tableNames = tables;
			next(err);
		});
	}

	function processTables(next) {
		function writeTable(tableName, next) {
			var start = Date.now(),
				//indent everything by one if modularize is set
				indent = options.modularize ? options.indent : '';
			log('info', 'Starting ' + options.database + '.' + (options.schema ? options.schema + '.' : '') + tableName + '...');
			stats.tables[tableName] = {
				columns: []
			};
			getListOfColumns(tableName, function(err, columnData) {
				if (err) {
					next(err);
					return;
				}

				log('debug', '  Found ' + columnData.length + ' columns');

				var args = [],
					fullName = (options.schema || options.database) + '.' + tableName;

				if (!options.omitComments) {
					args.push(indent + '/**');
					args.push(indent + ' * SQL definition for ' + fullName);
					args.push(indent + ' */');
				}

				args.push(indent + 'exports.' + tryCamelize(tableName) + ' = sql.define({');
				args.push(indent + options.indent + 'name: \'' + tableName + '\',');
				if (options.includeSchema) {
					args.push(indent + options.indent + 'schema: \'' + (options.schema || options.database) + '\',');
				}
				args.push(indent + options.indent + 'columns: [');

				args.push(columnData.map(function(column) {
					var columnString = indent + options.indent + options.indent + '{ ' +
						'name: \'' + column.name + '\'';
					var camelized = camelize(column.name);

					if (options.camelize) {
						columnString += ', property: \'' + camelized + '\'';
					}
					if (options.includeMeta) {
						columnString += ', type: \'' + column.type + '\'';
						columnString += ', nullable: ' + column.nullable;
						columnString += ', charLength: ' + column.charLength;
					}
					columnString += ' }';

					stats.tables[tableName].columns.push({
						name: column.name,
						property: camelized,
						type: column.type,
						nullable: column.nullable,
						charLength: column.charLength
					});
					return columnString;
				}).join(',' + options.eol));

				args.push(indent + options.indent + ']');
				args.push(indent + '});');
				args.push(options.eol);

				args.push(function(err) {
					if (!err) {
						log('debug', '  ...finished! (' + (Date.now() - start) + 'ms)');
					}

					next(err);
				});

				write.apply(null, args);
			});
		}

		async.eachSeries(tableNames, writeTable, next);
	}

	function writeTail(next) {
		if (options.modularize) {
			write(
				options.indent + 'return exports;',
				'};',
				tail
			);
		} else {
			tail();
		}

		function tail(err) {
			if (err) {
				next(err);
				return;
			}

			if (options.append) {
				write(options.append, next);
			} else {
				process.nextTick(next);
			}
		}
	}

	async.series([
		openFile,
		connect,
		writeHead,
		fetchTables,
		processTables,
		writeTail
	], function(appError) {
		if (appError) {
			log('error', appError);
		}

		stats.end = new Date();
		stats.elapsed = stats.end.getTime() - stats.start.getTime();
		if (fd && fd !== 1) {
			fs.close(fd, function(err) {
				if (err) {
					log('warn', 'Error closing file: ' + err);
				}

				log('info',
					'\nAll done! Wrote ' + stats.bytesWritten + ' bytes to ' +
						(options.outputFile || 'stdout') + ' in ' + stats.elapsed + 'ms',
					'yay!'
				);

				callback(appError, stats);
			});
		} else {
			callback(appError, stats);
		}
	});
};
