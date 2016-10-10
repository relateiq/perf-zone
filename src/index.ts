///<reference path="../typings/index.d.ts" />
declare var require: NodeRequire;
const flatten = require('lodash/flatten');
const snakecase = require('lodash/snakeCase');
const unique = require('lodash/uniq');

interface MemoryInfo {
    usedJSHeapSize: number,
    totalJSHeapSize: number,
    jsHeapSizeLimit: number
}

interface Performance {
    memory: MemoryInfo,
    webkitClearResourceTimings: Function
}

interface XMLHttpRequest {
    responseURL: string
}

interface RiqPerfMark {
    timelineId: number,
    name: string,
    timestamp: number,
    timelineStart: number
}

interface RiqPerfTimeline {
    id: number,
    action: string,
    components: string[],
    created_timestamp: number,
    time_since_page_load: number,
    totalTimeouts: number,
    totalIntervals: number,
    numWaiting: number
}

interface AsyncIdToTimelineIdMap {
    [key: number]: number
}

interface TimelineMap {
    [key: number]: RiqPerfTimeline
}


require('./performance-now');

let timelineId = 0;
let networkIdCount = 0;

// current timeline should be set as the timeline that is associated with the latest js turn
let currentTimeline: RiqPerfTimeline;
let lastEvent: Event;
let lastEventTimestamp: number;
const timeoutIdToTimelineId: AsyncIdToTimelineIdMap = {};
const networkIdToTimelineId: AsyncIdToTimelineIdMap = {};
let waitingTimelinesById: TimelineMap = {};
let notWaitingTimelinesById: TimelineMap = {};
const timeoutIdChainCounts: { [key: number]: number } = {};
let timelines: RiqPerfTimeline[] = [];
let marks: RiqPerfMark[] = [];

const TRIGGER_EVENTS = ['keydown', 'keypress', 'keyup', 'mousedown', 'mouseup', 'click', 'dblclick', 'mousemove', 'mouseover', 'mousewheel', 'mouseout', 'resize', 'scroll'];
const NETWORK_PROPS = ['startTime', 'fetchStart', 'domainLookupStart', 'domainLookupEnd', 'connectStart', 'connectEnd', 'requestStart', 'responseStart', 'responseEnd'];

//other possible triggers resize, mutation observers, transition events, web workers

function riqPerfEventCapture(e: Event) {
    //if we didn't get dom manip the next user event will complete the prior timeline
    maybeCompleteTimelines();
    lastEvent = e;
    lastEventTimestamp = window.performance.now();
    currentTimeline = null;
}

function addTcsToTimeline(timeline, target, useTextForFirst) {
    if (target instanceof Node) {
        let tcInfo = getParentTcs(target, undefined, useTextForFirst);
        timeline.components = timeline.components.concat(tcInfo.tcs);
        if (tcInfo.parentNode !== document.body) {
            // our target had been removed from the dom during the event execution
            timeline.targetLastParent = tcInfo.parentNode;
        } else {
            timeline.targetLastParent = undefined;
        }
    }
}

function createTimelineFromTrigger(e: Event, lastEventTimestamp: number) {
    const target = e.target;


    let timeline: RiqPerfTimeline = {
        id: ++timelineId,
        action: e.type,
        components: [],
        created_timestamp: Date.now(),
        time_since_page_load: lastEventTimestamp,
        totalTimeouts: 0,
        totalIntervals: 0,
        numWaiting: 0
    };

    addTcsToTimeline(timeline, target, true);

    if (window.performance.memory) {
        ['usedJSHeapSize', 'totalJSHeapSize', 'jsHeapSizeLimit'].forEach(function(key) {
            timeline[key] = window.performance.memory[key] / 1000 / 1000;
        });
    }
    timelines.push(timeline);
    return timeline;
}

function getCurrentTimeline() {
    if (!currentTimeline && lastEvent) {
        currentTimeline = createTimelineFromTrigger(lastEvent, lastEventTimestamp);
        lastEvent = null;
        lastEventTimestamp = null;
    }
    return currentTimeline;
}

function makeMark(name: string, detail: { [key: string]: any }, timestampOverride: number, timeline: RiqPerfTimeline) {
    let mark: RiqPerfMark = {
        timelineId: timeline.id,
        name: name,
        timestamp: ((timestampOverride || window.performance.now()) - timeline.time_since_page_load),
        timelineStart: timeline.time_since_page_load
    };
    if (detail) {
        Object.keys(detail).forEach(function(key) {
            mark[key] = detail[key];
        });
    }
    return mark;
}

function trackedClearInterval(intervalId: number) {
    if (riqPerformance.started) {
        completeTimeout(intervalId);
    }
    riqPerformance.clearInterval.call(this, intervalId);
}

function trackedInterval() {
    if (!riqPerformance.started) {
        return riqPerformance.setInterval.apply(this, arguments);
    }
    const origCb = arguments[0];
    let stack;
    if(riqPerformance.logTimeoutStacks){
        stack = new Error().stack;
    }
    let count = 0;
    arguments[0] = function riqPerfTrackedIntervalCallback() {
        // treat interval execution like an event so it will have it's own timeline and complete previous
        currentTimeline = waitingTimelinesById[timeoutIdToTimelineId[intervalId]];
        riqPerformance.addMark('interval_callback', {stack : stack});
        if (typeof origCb === 'function') {
            origCb.apply(this, arguments);
        }
        riqPerformance.addMark('interval_callback_done');
    };
    const intervalId = riqPerformance.setInterval.apply(this, arguments);
    const timeline = getCurrentTimeline();
    riqPerformance.addMark('set_interval', {stack : stack, delay : arguments[1]});
    if (timeline) {
        timeline.totalIntervals++;
        incrementTimelineWait(timeline);
        timeoutIdToTimelineId[intervalId] = timeline.id;
    }
    return intervalId;
}

function trackedTimeout() {
    if (!riqPerformance.started) {
        return riqPerformance.setTimeout.apply(this, arguments);
    }
    const origCb = arguments[0];
    let stack;
    if(riqPerformance.logTimeoutStacks){
        stack = new Error().stack;
    }

    arguments[0] = function riqPerfTrackedTimeoutCallback() {
        currentTimeline = completeTimeout(timeoutId);
        riqPerformance.addMark('timeout_callback', {stack : stack});
        if (typeof origCb === 'function') {
            origCb.apply(this, arguments);
        };
        riqPerformance.addMark('timeout_callback_done');
    };

    const timeoutId = riqPerformance.setTimeout.apply(this, arguments);
    const timeline = getCurrentTimeline();
    riqPerformance.addMark('set_timeout', {stack : stack, delay : arguments[1]});
    if (timeline) {
        timeline.totalTimeouts++;
        incrementTimelineWait(timeline);
        timeoutIdToTimelineId[timeoutId] = timeline.id;
    }
    return timeoutId;
}

function trackedClearTimeout(timeoutId: number) {
    if (riqPerformance.started) {
        completeTimeout(timeoutId);
    }
    riqPerformance.clearTimeout.call(this, timeoutId);
}

function incrementTimelineWait(timeline: RiqPerfTimeline) {
    timeline.numWaiting++;
    waitingTimelinesById[timeline.id] = timeline;
    notWaitingTimelinesById[timeline.id] = null;
}

function maybeRemoveFromWaiting(timeline: RiqPerfTimeline) {
    if (!isTimelineWaiting(timeline)) {
        waitingTimelinesById[timeline.id] = null;
        notWaitingTimelinesById[timeline.id] = timeline;
    }
}

function completeTimeout(timeoutId: number) {
    return completeAsync(timeoutId, timeoutIdToTimelineId);
}

function completeAjax(networkId: number) {
    return completeAsync(networkId, networkIdToTimelineId);
}

function completeAsync(asyncId: number, timelineIdsByAsyncId: AsyncIdToTimelineIdMap) {
    const timeline = waitingTimelinesById[timelineIdsByAsyncId[asyncId]];
    if (!timeline) {
        return;
    }
    timeline.numWaiting--;
    timelineIdsByAsyncId[asyncId] = null;
    maybeRemoveFromWaiting(timeline);
    return timeline;
}

function getAttributeAndRespectRegex(node, attr) {
    var value = node.getAttribute(attr);
    return value && value.replace(riqPerformance.ignoreTcOrClassRegex, '');
}

function getTcFromNode(node: Node) {
    if (node instanceof Element) {
        return getAttributeAndRespectRegex(node, 'tc') ||
        getAttributeAndRespectRegex(node, 'tv') ||
        getAttributeAndRespectRegex(node, 'class');
    }
}

function getTcsFromNode(node: Node, tcs?: string[]) {
    tcs = tcs || [];
    let thisTc = getTcFromNode(node);
    if (thisTc) {
        tcs.push(thisTc);
    }
    return tcs;
}

function getParentTcs(node: Node, tcs?: string[], useTextForFirst?: boolean) {
    tcs = getTcsFromNode(node, tcs);
    if (!tcs.length && useTextForFirst) {
        tcs.push(node.textContent.substr(0, 50));
    }
    if (node.parentNode) {
        return getParentTcs(node.parentNode, tcs);
    }
    return {
        tcs: tcs,
        parentNode: node
    };
}

function getChildTcs(node: Node, tcs?: string[]) {
    tcs = getTcsFromNode(node, tcs);
    if (node.childNodes && node.childNodes.length) {
        Array.prototype.slice.call(node.childNodes).forEach(function(child) {
            getChildTcs(child, tcs);
        });
    }
    return tcs;
}

function maybeIncrementMutationCount(counts: { [key: string]: number }, tc: string, type: string) {
    if (!tc) {
        return;
    }
    let countKey = tc + ' ' + type;
    const count = counts[countKey];
    if (!count) {
        counts[countKey] = 1;
    } else {
        counts[countKey] = count + 1;
    }

}

function incrementCountForNode(mutationCounts: { [key: string]: number }, node: Node, addOrRemove: string, mutation: MutationRecord) {
    if (node.nodeType === 3) { // it's a text node, so we increment the count of the mutation's target (aka the parent of this text node)
        maybeIncrementMutationCount(mutationCounts, getTcFromNode(mutation.target), 'TEXT');
        return;
    }
    let tcs = getChildTcs(node);
    tcs.forEach(function(tc: string) {
        maybeIncrementMutationCount(mutationCounts, tc, addOrRemove);
    });
}

function maybeReconstructTcsFromMutations(timeline, mutations) {
    if (!timeline.targetLastParent) {
        return;
    }
    let idUniqueToThisFn = 1;
    var lastParentToMutationTarget = mutations.reduce(function(map, mutation) {
        for (var i = 0; i < mutation.removedNodes.length; ++i) {
            let removedNode = mutation.removedNodes[i];
            removedNode._perfElementId = idUniqueToThisFn++;
            map[removedNode._perfElementId] = mutation.target;
        }
        return map;
    }, {})

    // if this is the mutation that contained our removed target
    let lastParent = undefined;
    while (timeline.targetLastParent && lastParent !== timeline.targetLastParent) {
        lastParent = timeline.targetLastParent;
        addTcsToTimeline(timeline, lastParentToMutationTarget[timeline.targetLastParent._perfElementId], false);
    }
}

function createRenderMarksForMutations(mutations: MutationRecord[]) {
    if (!mutations.length) {
        return;
    }
    const timeline = getCurrentTimeline();
    var counts = mutations.reduce(function(mutationCounts: { [key: string]: number }, mutation: MutationRecord) {
        switch (mutation.type) {
            case 'attributes':
                maybeIncrementMutationCount(mutationCounts, getTcFromNode(mutation.target), 'ATTR');
                break;
            case 'childList':
                Array.prototype.slice.call(mutation.addedNodes).forEach(function(node: Node) {
                    incrementCountForNode(mutationCounts, node, 'ADD', mutation);
                });
                Array.prototype.slice.call(mutation.removedNodes).forEach(function(node: Node) {
                    incrementCountForNode(mutationCounts, node, 'REMOVE', mutation);
                });
                break;
        }
        return mutationCounts;
    }, {});

    maybeReconstructTcsFromMutations(timeline, mutations);
    var tcs = Object.keys(counts).map(function(tc: string) {
        return tc + ' ' + counts[tc];
    });
    riqPerformance.addMark('render', {
        components: tcs,
        numTimeouts: timeline.totalTimeouts
    });
}

const componentObserver = new MutationObserver(function(mutations: MutationRecord[]) {
    createRenderMarksForMutations(mutations);
});

function maybeCompleteTimelines() {
    Object.keys(notWaitingTimelinesById).forEach(function(timelineId) {
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

function riqPerformanceNetworkHandler(url, promise) {
    if (!riqPerformance.started) {
        return;
    }
    const timeline = getCurrentTimeline();
    if (!timeline) {
        return;
    }
    const networkId = ++networkIdCount;
    const startMark = riqPerformance.addMark('network_send', {
        numTimeouts: timeline.totalTimeouts,
        url: url
    });
    incrementTimelineWait(timeline);
    networkIdToTimelineId[networkId] = timeline.id;
    const entries = window.performance.getEntriesByType && window.performance.getEntriesByType('Resource') || [];
    //if these are about to get maxed we have to clear or we will lose resolution on the network timing
    if (entries.length >= 149) {
        // these throw illegal invocation if stored in var so they must be invoked this way
        if (window.performance.clearResourceTimings) {
            window.performance.clearResourceTimings();
        } else if (window.performance.webkitClearResourceTimings) {
            window.performance.webkitClearResourceTimings();
        }
    }

    function getCallback(eventName) {
        return function(e: ProgressEvent) {
            let networkDetail = {
                numTimeouts: timeline.totalTimeouts,
                url: url
            };
            var responseURL = e.target && (<XMLHttpRequest>e.target).responseURL;
            var lookupUrl = responseURL || url;

            const networkDetailCB = riqPerformance['getNetworkDetail'];
            if (networkDetailCB instanceof Function) {
                let extraDetail = networkDetailCB.apply(this, arguments);
                Object.assign(networkDetail, extraDetail);
                Object.assign(startMark, extraDetail);
            }
            //do this before adding marks
            currentTimeline = completeAjax(networkId);
            if (currentTimeline !== timeline) {
                debugger;
            }
            const completionMark = riqPerformance.addMark(eventName, networkDetail);
            let resourceEntry;
            const entries = window.performance.getEntriesByType && window.performance.getEntriesByType('Resource') || [];
            for (let i = entries.length - 1; i >= 0; i--) {
                const entry = entries[i];
                //find the entry that started after we made the network request and shares its url
                if (entry.name.indexOf(lookupUrl) !== -1) {
                    const startTime = startMark.timestamp + startMark.timelineStart;
                    if (entry.startTime > startTime) {
                        //get the closest entry to our timeline start in case there have been more since
                        if (!resourceEntry || (resourceEntry.startTime - startTime > entry.startTime - startTime)) {
                            resourceEntry = entry;
                        }
                    }
                }
            }
            if (resourceEntry) {
                NETWORK_PROPS.forEach(function(networkProp) {
                    // only add marks for parts of the timing that actually have a value
                    var timeStamp = resourceEntry[networkProp];
                    if (timeStamp) { // 0 absolutely counts as not having a value
                        riqPerformance.addMark('network_' + snakecase(networkProp), networkDetail, timeStamp);
                    }
                });
            } else if (eventName !== 'network_error') { // TODO: only log this in debug mode
                console.log('could not find entry for ' + url + ' that started after we sent the request');
            }


        };
    }

    promise.then(getCallback('network_success'), getCallback('network_error'));

}

const riqPerformance = {
    onTimelineComplete: function(timeline: RiqPerfTimeline) {
        //noop to prevent npes
    },
    logTimeoutStacks : false,
    started: false,
    ignoreTcOrClassRegex: new RegExp('(^|\\s)+((ng-[^\\s]+))', 'g'),
    start: function start(cb?: (timeline: RiqPerfTimeline) => void) {
        riqPerformance.onTimelineComplete = cb || riqPerformance.onTimelineComplete;
        TRIGGER_EVENTS.forEach(function(type) {
            document.body.addEventListener(type, riqPerfEventCapture, true);
        });

        componentObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true
        });
        riqPerformance.started = true;
    },
    stop: function() {
        TRIGGER_EVENTS.forEach(function(type) {
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
    addMark: function addMark(name: string, detail?: { [key: string]: any }, timestampOverride?: number) {
        const timeline = getCurrentTimeline();
        if (timeline) {
            const mark = makeMark.call(this, name, detail, timestampOverride, timeline);
            marks.push(mark);
            return mark;
        }
    },
    pageLoadTimestamp: new Date().getTime(),
    popAllTimelines: function() {
        const popped = timelines;
        timelines = [];
        return popped;
    },
    popAllMarks: function() {
        const popped = marks;
        marks = [];
        return popped;
    }
};


const origXHR: { new (...args: any[]): XMLHttpRequest } = window['XMLHttpRequest'];
window['XMLHttpRequest'] = function() {
    const xhr = new origXHR(arguments[0]);
    const origOpen = xhr.open;
    let promiseResolve, promiseReject;
    const promise = new Promise(function(resolve, reject) {
        promiseResolve = resolve;
        promiseReject = reject;
    });

    function success() {
        if (!riqPerformance.started) {
            return;
        }
        promiseResolve.apply(this, arguments);
    }

    function error() {
        if (!riqPerformance.started) {
            return;
        }
        promiseReject.apply(this, arguments);
    }


    xhr.open = function riqPerfXhrOpen() {
        const url = arguments[1];
        if (riqPerformance.started) {
            riqPerformanceNetworkHandler(url, promise);
        }
        var openResult = origOpen.apply(this, arguments);
        return openResult;
    };
    xhr.addEventListener('load', function(e) {
        if (!e.target) {
            return;
        }
        var status = (<XMLHttpRequest>e.target).status || 0;
        // 304 never makes it here because the browser turns it into 200 for some reason but just in case...
        if (200 <= status && status < 300 || status === 304) {
            success.apply(this, arguments);
        } else {
            error.apply(this, arguments);
        }
    });
    xhr.addEventListener('abort', error);
    xhr.addEventListener('error', error);
    return xhr;
};

//have to do these right away in case someone traps setInterval, etc. in a closure
window.setTimeout = trackedTimeout;
window.clearTimeout = trackedClearTimeout;
window.setInterval = trackedInterval;
window.clearInterval = trackedClearInterval;

riqPerfEventCapture(new CustomEvent('page_load'));

riqPerformance.start(); //start by default to not miss events

module.exports = riqPerformance;
//FOR DEBUGGING ONLY
if (window) {
    window['riqPerformance'] = riqPerformance;
}
