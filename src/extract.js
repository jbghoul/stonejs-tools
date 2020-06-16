"use strict";

var fs = require("fs");

var async = require("async");
var glob = require("glob");
var espree = require("espree");
var gettextParser = require("gettext-parser");
var cheerio = require("cheerio");

var helpers = require("./helpers.js");


/**
 * @class extract
 * @constructor
 */
var extract = {};

/**
 * Run all the string extraction process (list files, read files, extract string, generate po template, write po template).
 *
 * options:
 *
 *     {
 *         'functions': ["_", "gettext", "lazyGettext"],   // The name of the gettext functions
 *         'pluralFunctions': ["N_", "ngettext", "lazyNgettext"],   // The name of the ngettext functions
 *         'quiet': false   // If true: do not output logs
 *     }
 *
 * @method main
 * @static
 * @param {Array} jsFiles list of js files to parse (can contain glob pattern)
 * @param {String} output the output file (.pot)
 * @param {Object} options additional options (optional, default: see above)
 * @param {Function} callback function called when everything is done (optional)
 */
extract.main = function(jsFiles, output, options, callback) {
    options = options || {};
    if (options.functions === undefined) {
        options.functions = ["_", "gettext", "lazyGettext"];
    }
    else if (typeof options.functions == "string") {
        options.functions = options.functions.split(",");
    }
    if (options.pluralFunctions === undefined) {
        options.pluralFunctions = ["N_", "ngettext", "lazyNgettext"];
    }
    else if (typeof options.pluralFunctions == "string") {
        options.pluralFunctions = options.pluralFunctions.split(",");
    }
    callback = callback || function(){};

    var files = [];
    var strings = {};
    var skipped = 0;

    async.each(jsFiles,

        function(jsFile, doneCb) {
           glob(jsFile, {}, function(error, matchingFiles) {
               files = files.concat(matchingFiles);
               doneCb();
           });
        },

        function() {
            async.each(files,

                function(file, doneCb) {
                    if (!helpers.isFile(file)) {
                        if (!helpers.isDir(file)) {
                            helpers.warn("File not found: " + file, options);
                            skipped += 1;
                        }
                        doneCb();
                        return;
                    }
                    helpers.log("  * Extracting strings from '" + file + "'", options);
                    var data = fs.readFileSync(file, {encoding: "utf-8"});
                    var extractedStrings = {};
                    var ext = file.toLowerCase().split(".");
                    ext = ext[ext.length-1];
                    if (["html", "htm", "xhtml", "xml", "twig"].indexOf(ext) >= 0) {
                        extractedStrings = extract.extractHtmlStrings(data.toString());
                    }
                    else if (["jsx"].indexOf(ext) >= 0) {
                        try {
                            extractedStrings = extract.extractJsStrings(data.toString(), options.functions, options.pluralFunctions, true);
                        } catch (error) {
                            helpers.warn(error.toString(), options);
                            helpers.warn("File skipped due to syntax errors", options);
                            skipped += 1;
                            doneCb();
                            return;
                        }
                    }
                    else {
                        try {
                            extractedStrings = extract.extractJsStrings(data.toString(), options.functions, options.pluralFunctions, false);
                        } catch (error) {
                            helpers.warn(error.toString(), options);
                            helpers.warn("File skipped due to syntax errors", options);
                            skipped += 1;
                            doneCb();
                            return;
                        }
                    }
                    for (var str in extractedStrings) {
                        if (strings[str] === undefined) {
                            strings[str] = { refs: [] };
                        }
                        if(extractedStrings[str].msgid_plural) {
                            strings[str].msgid_plural = extractedStrings[str].msgid_plural;
                        }
                        for (var i=0 ; i<extractedStrings[str].refs.length ; i++) {
                            strings[str].refs.push({
                                file: file,
                                line: extractedStrings[str].refs[i]
                            });
                        }
                    }
                    doneCb();
                },

                function() {
                    helpers.log(
                        "\n\x1B[1;36m" + Object.keys(strings).length + "\x1B[0m string(s) extracted" +
                        ((skipped > 0) ? ", \x1B[1;31m" + skipped + "\x1B[0m file(s) skipped." : "."),
                        options);
                    fs.writeFile(output, extract.generatePo(strings), {encoding: "utf-8"}, function(error) {
                        if (error) {
                            helpers.error("An error occurred: " + error, options);
                        }
                        else {
                            helpers.ok("Translation template written: " + output, options);
                        }
                        callback(error);
                    });
                }
            );
        }
    );
};

/**
 * Extracts strings from the given Javascript source code.
 *
 * @method extractJsStrings
 * @static
 * @param {String} source The Javascript source code.
 * @param {string[]} functionsNames The name of th etranslation functions to search in the source.
 * @param {string[]} pluralFunctionsNames The name of the translation functions with plural support.
 * @param {boolean} [isJsx] whether source file is jsx
 * @return {Object} Translatable strings `{ <string>: [<lines>] }`.
 */
extract.extractJsStrings = function(source, functionsNames, pluralFunctionsNames, isJsx) {
    isJsx = isJsx || false;
    var strings = {};
    var ast = espree.parse(source, {
        tolerant: true,
        tokens: true,
        loc: true,
        ecmaVersion: 2019,
        sourceType: "module",
        ecmaFeatures: {
            jsx: isJsx,
        },
    });

    function _cleanString(str) {
        return new Function("return " + str + ";")();  // jshint ignore:line
    }

    var f_fn = false;  // In function flag
    var f_sp = false;  // In parenthesis flag
    var f_isPlural = false; // plural forms function flag
    var f_findPlural = false; // Find plural message id
    var msgBuff = true;   // Buff to concat splitted strings
    var msgid; // msgid
    var line; // msgid line
    var msgid_plural;
    function pushString() {
        if (strings[msgid] === undefined) {
            strings[msgid] = {};
        }
        if(strings[msgid].refs === undefined) {
            strings[msgid].refs = [];
        }
        strings[msgid].refs.push(line);
        if(f_isPlural) {
            strings[msgid].msgid_plural = msgid_plural;
        }
    }
    function stop() {
        f_fn = false;
        f_sp = false;
        f_isPlural = false;
        f_findPlural = false;
        msgBuff = "";
        msgid = undefined;
        line = undefined;
        msgid_plural = undefined;
    }
    for (var i=0 ; i<ast.tokens.length ; i++) {

        // ?
        if (!f_fn && !f_sp) {
            if (ast.tokens[i].type == "Identifier") {
                if(functionsNames.indexOf(ast.tokens[i].value) > -1) {
                    f_fn = true;
                } else if(pluralFunctionsNames.indexOf(ast.tokens[i].value) > -1) {
                    f_fn = true;
                    f_isPlural = true;
                    f_findPlural = false;
                }
            }
        }

        // functionName
        else if (f_fn && !f_sp) {
            if (ast.tokens[i].type == "Punctuator" && ast.tokens[i].value == "(") {
                f_sp = true;
                msgBuff = "";
            }
            else {
                f_fn = false;
            }
        }

        // functionName (
        else if (f_fn && f_sp) {
            if (ast.tokens[i].type == "String" || ast.tokens[i].type == "Numeric") {
                msgBuff += _cleanString(ast.tokens[i].value);
            }
            else if (ast.tokens[i].type == "Punctuator" && ast.tokens[i].value == "+") {
                continue;
            }
            else if (ast.tokens[i].type == "Identifier") {
                msgBuff = "";
                stop();
            }
            else {
                if(f_isPlural) {
                    if(f_findPlural) {
                        msgid_plural = msgBuff;
                        pushString();
                        stop();
                    } else {
                        msgid = msgBuff;
                        line = ast.tokens[i].loc.start.line;
                        msgBuff = "";
                        f_findPlural = true;
                    }

                } else {
                    msgid = msgBuff;
                    line = ast.tokens[i].loc.start.line;
                    pushString();
                    stop();
                }            
            }
        }
    }

    return strings;
};

/**
 * Extracts strings from the given HTML.
 *
 * @method extractHtmlStrings
 * @static
 * @param {String} source The HTML source code.
 * @return {Object} Translatable strings `{ <string>: [<lines>] }`.
 */
extract.extractHtmlStrings = function(source) {
    var $ = cheerio.load(source);
    var nodes = $("[stonejs]");
    var result = {};
    //console.log(nodes("[stonejs]"));
    nodes.each(function(node) {
        result[$(nodes[node]).html()] = { refs: [0] };
    });
    return result;
};

/**
 * Generates the .po file.
 *
 * @method generatePo
 * @static
 * @param {Object} strings the strings `{ "<msgid>": [{file: String, line: Number}] }`.
 * @return {String} the generated po file.
 */
extract.generatePo = function(strings) {

    function _buildRef(refs) {
        var result = "";
        for (var i=0 ; i<refs.length ; i++) {
            if (i > 0) result += "\n";
            result += refs[i].file + ":" + refs[i].line;
        }
        return result;
    }

    var date = new Date();
    var data = {
        "charset": "utf-8",

        headers: {
            "mime-version": "1.0",
            "content-type": "text/plain; charset=utf-8",
            "content-transfer-encoding": "8bit",
            "pot-creation-date": helpers.dateFormat(date),
            "po-revision-date": helpers.dateFormat(date),
            "language": "C",
            "plural-forms": "nplurals=2; plural=(n != 1);"
        },

        translations: {
            "": {
                // "<msgid>" {
                //     msgid: "<msgid>",
                //     msgstr: ["<msgstr>"],
                //     comments: {
                //         reference: "<ref1>\n<ref2>"
                //     }
                // }
            }
        }
    };

    for (var msgid in strings) {
        data.translations[""][msgid] = {
            msgid: msgid,
            msgstr: "",
            comments: {
                reference: _buildRef(strings[msgid].refs)
            }
        };
    }

    return gettextParser.po.compile(data).toString();
};


module.exports = extract;
