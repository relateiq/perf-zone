///<reference path="../typings/index.d.ts" />
declare var require: NodeRequire;

// This that LucidWeb normally provides
// These should all be listed as peerDependencies of the app
window['jQuery'] = require('jquery');
require('angular');

/* I've thought about this line for awhile.
 *
 * requiring the stuff from `src/` using the `var/require` method is nice
 * because you don't end up 'double-compiling'.  using the `import/require`
 * method causes all the source to get recompiled as a part of the app... which
 * is "technically" correct but not really what I'm looking for here (as in,
 * .app-src/src contains the same thing as .src)
 *
 * also this page is an app shell that bootstraps a similar environment to
 * LucidWeb, which is going to use the `var/require`, so it's not bad to use it
 * here too.  and really you shouldn't be adding much (if any) logic here, so
 * ultimately it doesn't matter.
 */
var spaPerf = require('../.src');
var _ = require('lodash');
var logTimelines = require('../.src/log-timelines');




// Set up the shell app w/angular, uiq, and a router
var router = require('web-core-router');
var routerOptions = {
    RouterCnst: router.makeRouterCnst()
};

/* even though shell-apps should really only have 1 view, having the url <=>
 * model binding is pretty nice (if say, you're working on import and want an
 * easy way to jump to step N)
 */
routerOptions.RouterCnst.STATES = {
    MAIN: {
        name: 'main',
        queryParams: [],
        lazyQueryParams: [],
        template: '<sample-module></sample-module>',
        modelBindings: {},
        default: true
    }
};

// Bootstrap the shell-app module and configure the router
module.exports = angular.module('shell-app', ['RouterCore', 'SampleModule'])
    .config(router.defaultRuleConfig(routerOptions.RouterCnst))
    .config(router.stateConfig(routerOptions))
    .run(router.run(routerOptions));

angular.module('SampleModule', [])
    .directive('sampleModule', function($http) {
        return {
            restrict: 'E',
            template: require('./sampleModule.html'),
            controller: function() {
                var ctrl = this;
                ctrl.timeoutDelay = 1000;
                ctrl.initInterval = function(delay) {
                    setInterval(function() {
                        var x = 'blah';
                        ctrl.clickToRenderADiv('exec-interval-div');
                    }, delay || ctrl.timeoutDelay || 1000);
                    ctrl.clickToRenderADiv('set-interval-div');
                };

                ctrl.initTimeout = function(delay) {
                    setTimeout(function() {
                        var x = 'blah';
                        ctrl.clickToRenderADiv('exec-timeout-div');
                    }, delay || ctrl.timeoutDelay || 1000);
                    ctrl.clickToRenderADiv('set-timeout-div');
                };

                function setLoopTimeout(delay) {
                    setTimeout(function() {
                        var x = 'blah';
                        ctrl.clickToRenderADiv('exec-looping-timeout-div');
                        setLoopTimeout(delay);
                    }, delay);
                    ctrl.clickToRenderADiv('set-looping-timeout-div');
                }

                ctrl.initLoopingTimeout = function() {
                    setLoopTimeout(ctrl.timeoutDelay || 1000);
                };

                ctrl.clickToRenderADiv = function(text?, notBody?) {
                    var div = document.createElement('div');
                    div.textContent = text || 'a div';
                    div.classList.add(_.kebabCase(text) || 'div-class');
                    if (notBody) {
                        document.querySelector('.app-content').appendChild(div);
                    } else {
                        document.body.appendChild(div);
                    }

                };

                ctrl.clickToRenderADivAndFocus = function() {
                    var input = document.querySelector('input[type="number"]');
                    if (input instanceof HTMLElement) {
                        input.focus();
                    }
                    ctrl.clickToRenderADiv();
                };

                ctrl.clickToRenderADivAndVanish = function(e) {
                    ctrl.clickToRenderADiv();
                    angular.element(e.target).remove();
                };

                ctrl.clickToSendNetworkRequest = function() {
                    var config = {
                        method: 'get',
                        url: 'https://httpbin.org/get'
                    }
                    $http(config).then(function() {
                        ctrl.clickToRenderADiv('network request completed');
                    });
                };

                ctrl.clickToSendCachedNetworkRequest = function() {
                    var config = {
                        method: 'get',
                        url: 'https://httpbin.org/cache',
                        headers: {
                            IfModifedSince: 'Mon, 26 Sep 2016 23:25:00 GMT'
                        }
                    }
                    $http(config).then(function() {
                        ctrl.clickToRenderADiv('network request completed');
                    });
                };

                ctrl.clickToSendFailedNetworkRequest = function() {
                    var config = {
                        method: 'get',
                        url: 'https://httpbin.org/get31324'
                    }
                    $http(config).then(function() {

                    }, function() {
                        ctrl.clickToRenderADiv('network request failed');
                    });
                };

                ctrl.clickToBoardTheCrazyChain = function() {
                    var input = document.querySelector('input[type="number"]');
                    if (input instanceof HTMLElement) {
                        input.focus();
                    }
                    ctrl.clickToRenderADiv('crazy train boarding click');
                    setInterval(function() {
                        ctrl.clickToRenderADiv('crazy train intervallllll');
                        setTimeout(function() {
                            ctrl.clickToRenderADiv('crazy train intervallllll timeout');
                            $http({ method: 'get', url: 'https://httpbin.org/ge2342343t' }).then(undefined, function() {
                                ctrl.clickToRenderADiv('crazy train intervallllll timeout network failure');
                                $http({ method: 'get', url: 'https://httpbin.org/get' }); // no dom resulting
                            });
                        }, 1000);
                    }, 10000);
                    $http({ method: 'get', url: 'https://httpbin.org/get' }).then(function() {
                        ctrl.clickToRenderADiv('crazy train network success');
                        setTimeout(function() {
                            ctrl.clickToRenderADiv('crazy train network success timeout');
                        }, 1);
                        ctrl.clickToRenderADiv('crazy train network success after setting timeout');
                    });
                };

                ctrl.logTimelines = logTimelines.logTimelines;
            },
            controllerAs: '$ctrl'
        };
    });



window['q$'] = window['jQuery'];
document.title = 'Spa Perf Test Harness';
