#!/usr/bin/env node

// load required modules
var _ = require('lodash'),
	async = require('async'),
	fs = require('fs'),
	pjson = require('../package.json'),
	program = require('commander'),
	ProgressBar = require('progress');

// configure cli options
program
	.version(pjson.version)
	.option('-i, --input <input-file>', 'Input File')
	.option('-o, --output <output-file>', 'Output File')
	.option('-f, --find <find-string>', 'Find String')
	.option('-r, --replace <replace-string>', 'Replace String')
	.option('-v, --verbose [boolean]', 'Verbose Output', function(value){
		value = value === null || value === undefined ? '' : value;
		value = value.toString().toLowerCase().trim();
		return /^1|(true)$/.test(value);
	}, false)
	.parse(process.argv);

// organize cli options
var options = {
	input: program.input,
	output: program.output,
	find: program.find,
	replace: program.replace
};

// honor verbose
var verbose = program.verbose;

// test cli options
if (_.compact(_.values(options)).length !== 4){
	return program.outputHelp();
}

//=================================================================//
// FUNCTIONS                                                       //
//=================================================================//

/**
 * read file contents
 *
 * @param {String} path
 * @return {String}
 */
function readFile(path){
	var contents = '';
	try {
		if (fs.lstatSync(path).isFile()){
			contents = fs.readFileSync(path, 'utf8');
		}
	} catch(e){}
	return contents;
}

/**
 * write file contents
 *
 * @param {String} path
 * @param {String} contents
 * @return {Void}
 */
function writeFile(path, contents){
	fs.writeFileSync(path, contents, 'utf8');
}

/**
 * format a number with commas
 *
 * @param {Integer} num
 * @return {String}
 */
function withCommas(num){
	return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * find serialized strings
 *
 * @param {String} sql
 * @return {Array}
 */
function findSerializedStrings(sql){
	var re = /[;{}]s:(\d+):"([^"]+)";/;
	var re2 = /^.s:(\d+):"(.*)";$/;
	var matches = (sql.match(new RegExp(re, 'g')) || []);
	var strings = _.map(matches, function(match){
		var parts = match.match(re2);
		return {
			source: parts[0],
			chars: parseInt(parts[1]),
			value: parts[2]
		};
	});
	return strings;
}

/**
 * count matches of one string inside another string
 *
 * @param {String} find
 * @param {String} source
 * @param {Boolean} ignoreCase (default=false)
 * @return {Integer}
 */
function countMatches(find, source, ignoreCase){
	ignoreCase = (ignoreCase !== undefined) ? !!ignoreCase : false;
	var re = new RegExp(find, 'gm' + (ignoreCase ? 'i' : ''));
	return (source.match(re) || []).length;
}

/**
 * rewrite serialized SQL values
 *
 * @param {String} sql
 * @param {String} find
 * @param {String} replace
 * @param {Function} callback
 * @return {String}
 */
function rewriteSerializedSql(sql, find, replace, callback){

	// get all serialized strings from sql
	var strings = findSerializedStrings(sql);

	// get serialized string count
	var stringCountOutput = withCommas(strings.length);
	if (program.verbose){
		console.log('SERIALIZED STRINGS: ' + stringCountOutput);
	}

	// create rewrite values
	var re = new RegExp(find);
	var re2 = new RegExp(find, 'g');
	var replaceCount = 0;
	strings = _.map(strings, function(string){
		string.rewriteChars = 0;
		string.rewriteValue = null;
		if (re.test(string.source)){
			string.rewriteValue = string.source.replace(re2, replace);
			string.rewriteChars = string.rewriteValue.replace(/^.s:\d+:"([^"]+)".$/, '$1').length;
			replaceCount++;
		}
		return string;
	});

	// remove empties
	strings = _.filter(strings, function(string){
		return string.rewriteChars !== 0;
	});

	// get serialized match count
	var replaceCountOutput = withCommas(replaceCount);
	if (program.verbose){
		console.log('SERIALIZED MATCHES: ' + replaceCountOutput);
	}

	// stop if we can
	if (replaceCount === 0){
		return callback(null, sql);
	}

	// everybody loves feedback
	if (program.verbose){

		// replace while showing a loading bar
		var bar = new ProgressBar('REWRITING STRINGS: :outputCurrent of :outputTotal | :percent' , {
			incomplete: '-',
			complete: '=',
			renderThrottle: 16,
			total: replaceCount,
			width: 40
		});
		var idx = 0;
		var timer = setInterval(function(){

			re = new RegExp('s:' + strings[idx].chars + ':"' + strings[idx].value + '"');
			sql = sql.replace(re, 's:' + strings[idx].rewriteChars + ':"' + strings[idx].rewriteValue + '"');
			idx++;
			bar.tick({
				outputCurrent: withCommas(idx),
				outputTotal: withCommas(replaceCount)
			});

			if (bar.complete){
				clearInterval(timer);
				callback(null, sql);
			}

		}, 50);
	} else {

		// replace finds
		_.each(strings, function(string){
			re = new RegExp('s:' + string.chars + ':"' + string.value + '"');
			sql = sql.replace(re, 's:' + string.rewriteChars + ':"' + string.rewriteValue + '"');
		});
		callback(null, sql);
	}
}

/**
 * initialize script
 *
 * @param {Function} callback
 * @return {Void}
 */
function initialize(callback){

	// get sql
	var sql = readFile(options.input);
	if (!sql){
		return callback(new Error('MISSING SQL'));
	}

	// organize data
	var data = {
		sql: sql,
		input: options.input,
		output: options.output,
		find: options.find,
		replace: options.replace,
		count: countMatches(options.find, sql)
	};

	// verbose output
	if (program.verbose){
		console.log('INPUT: ' + data.input);
		console.log('FIND: ' + data.find);
		console.log('REPLACE: ' + data.replace);
		console.log('MATCHES: ' + withCommas(data.count));
	}

	// ready to start
	callback(null, data);
}

/**
 * reserialize strings
 *
 * @param {Object} data
 * @param {Function} callback
 * @return {Void}
 */
function reserialize(data, callback){

	// count first
	var count = countMatches(data.find, data.sql);
	if (count === 0){
		return callback(null, data);
	}

	// rewrite serialized strings
	rewriteSerializedSql(data.sql, data.find, data.replace, function(err, sql){
		data.sql = sql;
		callback(err, data);
	});
}

/**
 * rewrite strings
 *
 * @param {Object} data
 * @param {Function} callback
 * @return {Void}
 */
function rewrite(data, callback){

	// count first
	var count = countMatches(data.find, data.sql);
	if (count === 0){
		return callback(null, data);
	}

	// replace
	var re = new RegExp(data.find, 'gm');
	data.sql = data.sql.replace(re, data.replace);

	// callback
	callback(null, data);
}

/**
 * complete script
 *
 * @param {String} err
 * @param {Object} data
 * @return {Void}
 */
function complete(err, data){

	// error
	if (!!err){
		console.error(err);
		process.exit(1);
	}

	// write file
	writeFile(data.output, data.sql);

	// finished
	if (program.verbose){
		console.log('POST MATCHES: ' + withCommas(countMatches(data.find, data.sql)));
		console.log('OUTPUT: ' + data.output);
	}
	process.exit(0);
}

//=================================================================//
// PROCESSING                                                      //
//=================================================================//

async.waterfall([
	initialize,
	reserialize,
	rewrite
], complete);

