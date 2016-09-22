///<reference path="../typings/index.d.ts" />
declare var require: NodeRequire;
const flatten = require('lodash/flatten');
const snakecase = require('lodash/snakecase');

interface MemoryInfo{
   usedJSHeapSize: number,
   totalJSHeapSize: number,
   jsHeapSizeLimit: number
}

interface Performance{
    memory: MemoryInfo,
    webkitClearResourceTimings : Function
}

interface RiqPerfMark{
    timelineId: number,
    name: string,
    timestamp: number,
    timelineStart: number
}

interface RiqPerfTimeline{
    id: number,
    action : string,
    components : string[],
    created_timestamp : number,
    time_since_page_load : number,
    totalTimeouts : number,
    totalIntervals : number,
    numWaiting : number
}

interface AsyncIdToTimelineIdMap{
    [key: number]: number
}

interface TimelineMap{
    [key: number]: RiqPerfTimeline
}


require('./performance-now');

let timelineId = 0;
let networkIdCount = 0;

// current timeline should be set as the timeline that is associated with the latest js turn
let currentTimeline : RiqPerfTimeline;
let lastEvent : Event;
let currentParentTimeoutCallback : Function;
let currentParentTimeoutId : number;
const timeoutIdToTimelineId : AsyncIdToTimelineIdMap = {};
const networkIdToTimelineId : AsyncIdToTimelineIdMap = {};
let waitingTimelinesById : TimelineMap = {};
let notWaitingTimelinesById : TimelineMap = {};
const timeoutIdChainCounts : {[key: number]: number} = {};
const MAX_INTERVAL_COUNT = 10;
var timelines : RiqPerfTimeline[] = [];
var marks : RiqPerfMark[] = [];
const TRIGGER_EVENTS = ['mousedown', 'keydown', 'mousewheel', 'mousemove'];
const NETWORK_PROPS = ['domainLookupStart', 'domainLookupEnd', 'connectStart', 'connectEnd', 'requestStart', 'responseStart', 'responseEnd'];

//other possible triggers resize, mutation observers, transition events, web workers

function riqPerfEventCapture(e : Event) {
    //if we didn't get dom manip the next user event will complete the prior timeline
    maybeCompleteTimelines();
    lastEvent = e;
    currentTimeline = null;
}

function createTimelineFromTrigger(e : Event) {
    var target = e.target;
    let tcs : string[]
    if(target instanceof Node){
        tcs = getParentTcs(target);
    }

    let timeline : RiqPerfTimeline = {
        id: ++timelineId,
        action: e.type,
        components: tcs,
        created_timestamp: Date.now(),
        time_since_page_load: window.performance.now(),
        totalTimeouts: 0,
        totalIntervals: 0,
        numWaiting: 0
    };
    if (window.performance.memory) {
        ['usedJSHeapSize', 'totalJSHeapSize', 'jsHeapSizeLimit'].forEach(function (key) {
            timeline[key] = window.performance.memory[key] / 1000 / 1000;
        });
    }
    timelines.push(timeline);
    return timeline;
}

function getCurrentTimeline() {
    if (!currentTimeline && lastEvent) {
        currentTimeline = createTimelineFromTrigger(lastEvent);
        lastEvent = null;
    }
    return currentTimeline;
}

function makeMark(name : string, detail : {[key: string]: any}, timestampOverride : number, timeline : RiqPerfTimeline) {
    let mark : RiqPerfMark = {
        timelineId: timeline.id,
        name: name,
        timestamp: ((timestampOverride || window.performance.now()) - timeline.time_since_page_load),
        timelineStart: timeline.time_since_page_load
    };
    if (detail) {
        Object.keys(detail).forEach(function (key) {
            mark[key] = detail[key];
        });
    }
    return mark;
}

function trackedClearInterval(intervalId) {
    if (riqPerformance.started) {
        completeTimeout(intervalId);
    }
    riqPerformance.clearInterval.call(this, intervalId);
}

function trackedInterval() {
    if (!riqPerformance.started) {
        return riqPerformance.setInterval.apply(this, arguments);
    }
    var isLongInterval = arguments[1] > 1000;
    var origCb = arguments[0];
    var count = 0;
    arguments[0] = function riqPerfTrackedIntervalCallback() {

        if (count <= MAX_INTERVAL_COUNT) {
            count++;
        } else {
            if (!isLongInterval) {
                completeTimeout(intervalId);
            }
            //treat interval execution like an event so it will have it's own timeline and complete previous
            riqPerfEventCapture(new CustomEvent('interval'));
        }
        if (typeof origCb === 'function') {
            origCb.apply(this, arguments);
        }

    };


    var intervalId = riqPerformance.setInterval.apply(this, arguments);
    if (isLongInterval) { //long intervals we will assume are non terminating
        count = MAX_INTERVAL_COUNT + 1;
        return intervalId;
    }
    var timeline = getCurrentTimeline();
    if (timeline) {
        timeline.totalIntervals++;
        incrementTimelineWait(timeline);
        timeoutIdToTimelineId[intervalId] = timeline.id;
    }
    return intervalId;
}

function checkTimeoutChainCount(timeoutId, parentId) {
    var isNonTerminating = false;
    var count;
    if (parentId) {
        count = timeoutIdChainCounts[parentId];
        delete timeoutIdChainCounts[parentId];
        if (count > 10) {
            isNonTerminating = true;
        }
        timeoutIdChainCounts[timeoutId] = (count || 0) + 1;
    }
    return isNonTerminating;
}

function trackedTimeout() {
    if (!riqPerformance.started) {
        return riqPerformance.setTimeout.apply(this, arguments);
    }
    var origCb = arguments[0];

    //assume this is a recursive timeout aka they should have used an interval
    var isNonTerminating;

    arguments[0] = function riqPerfTrackedTimeoutCallback() {
        if (!isNonTerminating) {
            currentTimeline = completeTimeout(timeoutId);
        } else {
            console.log('got timeout setting same callback within callback. treating it like an interval');
            riqPerfEventCapture(new CustomEvent('pseudo_interval'));
        }
        var prevParent = currentParentTimeoutCallback;
        var prevId = currentParentTimeoutId;
        currentParentTimeoutCallback = origCb;
        currentParentTimeoutId = timeoutId;
        typeof origCb === 'function' && origCb.apply(this, arguments);
        currentParentTimeoutCallback = prevParent;
        currentParentTimeoutId = prevId;
    };

    var timeoutId = riqPerformance.setTimeout.apply(this, arguments);
    isNonTerminating = checkTimeoutChainCount(timeoutId, currentParentTimeoutId);
    if (!isNonTerminating) {
        var timeline = getCurrentTimeline();
        if (timeline) {
            timeline.totalTimeouts++;
            incrementTimelineWait(timeline);
            timeoutIdToTimelineId[timeoutId] = timeline.id;
        }
    }
    return timeoutId;
}

function trackedClearTimeout(timeoutId) {
    if (riqPerformance.started) {
        completeTimeout(timeoutId);
    }
    riqPerformance.clearTimeout.call(this, timeoutId);
}

function incrementTimelineWait(timeline) {
    timeline.numWaiting++;
    waitingTimelinesById[timeline.id] = timeline;
    notWaitingTimelinesById[timeline.id] = null;
}

function maybeRemoveFromWaiting(timeline) {
    if (!isTimelineWaiting(timeline)) {
        waitingTimelinesById[timeline.id] = null;
        notWaitingTimelinesById[timeline.id] = timeline;
    }
}

function completeTimeout(timeoutId) {
    return completeAsync(timeoutId, timeoutIdToTimelineId);
}

function completeAjax(networkId) {
    return completeAsync(networkId, networkIdToTimelineId);
}

function completeAsync(asyncId, timelineIdsByAsyncId) {
    var timeline = waitingTimelinesById[timelineIdsByAsyncId[asyncId]];
    if (!timeline) {
        return;
    }
    timeline.numWaiting--;
    timelineIdsByAsyncId[asyncId] = null;
    maybeRemoveFromWaiting(timeline);
    return timeline;
}

function getTcsFromNode(node : Node, tcs? : string[]) {
    tcs = tcs || [];
    let thisTc;
    if (node instanceof Element) {
        thisTc = node.getAttribute('tc') || node.getAttribute('class');
    }
    if (thisTc) {
        tcs.push(thisTc);
    }
    return tcs;
}

function getParentTcs(node : Node, tcs? : string[]) {
    tcs = getTcsFromNode(node, tcs);
    if (node.parentNode) {
        return getParentTcs(node.parentNode, tcs);
    }
    return tcs;
}

function getChildTcs(node : Node, tcs? : string[]) {
    tcs = getTcsFromNode(node, tcs);
    if (node.childNodes && node.childNodes.length) {
        Array.prototype.slice.call(node.childNodes).forEach(function (child) {
            getChildTcs(child, tcs);
        });
    }
    return tcs;
}

function tcMutationHandler(nodes) {
    if (nodes.length) {
        //it really shouldn't be possible not to have one of these but in tests it is so null check to be safe
        var timeline = getCurrentTimeline();
        if (timeline) {
            var tcs = [];
            nodes.forEach(function (node) {
                getChildTcs(node, tcs);
            });
            var counts = {};
            tcs.forEach(function (tc) {
                var count = counts[tc];
                if (!count) {
                    counts[tc] = 1;
                } else {
                    counts[tc] = count + 1;
                }
            });
            tcs = [];
            Object.keys(counts).forEach(function (tc) {
                tcs.push(tc + ' ' + counts[tc]);
            });
            riqPerformance.addMark('render', {
                componenent_list: tcs,
                numTimeouts: timeline.totalTimeouts
            });
        }
    }
}

function collectNodesFromMutation(mutation) {
    var result = [];
    switch (mutation.type) {
        case 'attributes':
            result.concat(mutation.addedNodes).concat(mutation.removedNodes);
            break;
        case 'childList':
            result.push(mutation.target);
            break;
    }
    return result;
}


function maybeCompleteTimelines() {
    Object.keys(notWaitingTimelinesById).forEach(function (timelineId) {
        let timeline = notWaitingTimelinesById[timelineId];
        if (timeline && !isTimelineWaiting(timeline)) {
            if (riqPerformance.started && riqPerformance.onTimelineComplete) {
                riqPerformance.onTimelineComplete(timeline);
            }
        }
    });
    notWaitingTimelinesById = {};
    currentTimeline = null;
}

function isTimelineWaiting(timeline) {
    return timeline.numWaiting > 0;
}

var componentObserver = new MutationObserver(function (mutations) {
    var nodes = angular.element.unique(flatten(mutations.map(collectNodesFromMutation)));
    tcMutationHandler(nodes);
});

function riqPerformanceNetworkHandler(url, promise) {
    if (!riqPerformance.started) {
        return;
    }
    var timeline = getCurrentTimeline();
    if (!timeline) {
        return;
    }
    var networkId = ++networkIdCount;
    var startMark = riqPerformance.addMark('network_send', {
        numTimeouts: timeline.totalTimeouts,
        url: url
    });
    incrementTimelineWait(timeline);
    networkIdToTimelineId[networkId] = timeline.id;
    var entries = window.performance.getEntriesByType && window.performance.getEntriesByType('Resource') || [];
    //if these are about to get maxed we have to clear or we will lose resolution on the network timing
    if (entries.length >= 149) {
        if (window.performance.clearResourceTimings) {
            window.performance.clearResourceTimings();
        } else if (window.performance.webkitClearResourceTimings) {
            window.performance.webkitClearResourceTimings();
        }
        //TODO: other browsers?
    }

    function getCallback(eventName) {
        return function () {
            var networkDetail = {
                numTimeouts: timeline.totalTimeouts,
                url: url
            };
            var networkDetailCB = riqPerformance['getNetworkDetail'];
            if (networkDetailCB instanceof Function) {
                var extraDetail = networkDetailCB.apply(this, arguments);
                Object.assign(networkDetail, extraDetail);
                Object.assign(startMark, extraDetail);
            }
            //do this before adding marks
            currentTimeline = completeAjax(networkId);
            if (currentTimeline !== timeline) {
                debugger;
            }
            var completionMark = riqPerformance.addMark(eventName, networkDetail);
            var resourceEntry;
            var entry;
            var entries = window.performance.getEntriesByType && window.performance.getEntriesByType('Resource') || [];
            for (var i = entries.length - 1; i >= 0; i--) {
                entry = entries[i];
                //find the entry that started after we made the network request and shares its url
                if (entry.name.has(url)) {
                    var startTime = startMark.timestamp + startMark.timelineStart;
                    if (entry.domainLookupStart > startTime) {
                        //get the closest entry to our timeline start in case there have been more since
                        if (!resourceEntry || resourceEntry.domainLookupStart - startTime > entry.domainLookupStart - startTime) {
                            resourceEntry = entry;
                        }
                    }
                }
            }
            if (resourceEntry) {
                NETWORK_PROPS.forEach(function (networkProp) {
                    riqPerformance.addMark('network_' + snakecase(networkProp), networkDetail, resourceEntry[networkProp]);
                });
            } else if (eventName !== 'network_error') { // TODO: only log this in debug mode
                console.log('could not find entry for ' + url + ' that started after we sent the request');
            }


        };
    }

    promise.then(getCallback('network_success'), getCallback('network_error'));

}

var riqPerformance = {
    onTimelineComplete : function (timeline: RiqPerfTimeline) {
          //noop to prevent npes
    },
    started : false,
    start: function start(cb? : (timeline: RiqPerfTimeline) => void) {
        riqPerformance.onTimelineComplete = cb || riqPerformance.onTimelineComplete;
        TRIGGER_EVENTS.forEach(function (type) {
            document.body.addEventListener(type, riqPerfEventCapture, true);
        });

        componentObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true
        });
        riqPerformance.started = true;
    },
    stop: function () {
        TRIGGER_EVENTS.forEach(function (type) {
            document.body.removeEventListener(type, riqPerfEventCapture);
        });
        componentObserver.disconnect();
        window.setTimeout = riqPerformance.setTimeout;
        window.clearTimeout = riqPerformance.clearTimeout;
        window.setInterval = riqPerformance.setInterval;
        window.clearInterval = riqPerformance.clearInterval;
        riqPerformance.started = false;
    },
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
    addMark: function addMark(name : string, detail : {[key : string] : any}, timestampOverride? : number) {
        var timeline = getCurrentTimeline();
        if (timeline) {
            var mark = makeMark.call(this, name, detail, timestampOverride, timeline);
            marks.push(mark);
            return mark;
        }
    },
    pageLoadTimestamp: new Date().getTime(),
    popAllTimelines : function () {
        var popped = timelines;
        timelines = [];
        return popped;
    },
    popAllMarks : function () {
        var popped = marks;
        marks = [];
        return popped;
    }
};


var origXHR : { new(...args: any[]): XMLHttpRequest } = window['XMLHttpRequest'];
window['XMLHttpRequest'] = function () {
    var xhr = new origXHR(arguments[0]);
    var origOpen = xhr.open;
    var success, error;
    var promise = new Promise(function (resolve, reject) {
        success = resolve;
        error = reject;
    });
    xhr.open = function riqPerfXhrOpen() {
        var url = arguments[1];
        riqPerformanceNetworkHandler(url, promise);
        return origOpen.apply(this, arguments);
    };
    xhr.addEventListener('load', success);
    xhr.addEventListener('abort', error);
    xhr.addEventListener('error', error);
    return xhr;
};

//have to do these right away in case someone traps setInterval, etc. in a closure
window.setTimeout = trackedTimeout;
window.clearTimeout = trackedClearTimeout;
window.setInterval = trackedInterval;
window.clearInterval = trackedClearInterval;

lastEvent = new CustomEvent('page_load');

riqPerformance.start(); //start by default to not miss events

module.exports = riqPerformance;
//FOR DEBUGGING ONLY
if (window) {
    window['riqPerformance'] = riqPerformance;
}
