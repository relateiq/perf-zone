///<reference path="../typings/index.d.ts" />

declare var require: NodeRequire;
let spaPerf = require('./');
let uniq = require('lodash/uniq');
var timelineMap = {};
function logTimelines() {
    var timelines = spaPerf.popAllTimelines();
    var changedTimelineIds = [];
    timelines.reduce(function(map, timeline) {
        timeline.marks = timeline.marks || [];
        map[timeline.id] = timeline;
        changedTimelineIds.push(timeline.id);
        return map;
    }, timelineMap);

    var marks = spaPerf.popAllMarks();
    marks.forEach(function(mark) {
        var timeline = timelineMap[mark.timelineId];
        changedTimelineIds.push(timeline.id);
        timeline.marks.push(mark);
    });

    changedTimelineIds = uniq(changedTimelineIds);
    if (!changedTimelineIds.length) {
        console.log('No new timelines');
    }
    changedTimelineIds.forEach(function(timelineId) {
        var timeline = timelineMap[timelineId];
        timeline.marks = timeline.marks.sort(function(mark1, mark2) {
            return mark1.timestamp - mark2.timestamp;
        });
        logTimeline(timeline);
    });
};

function analyzeTimeline(timeline) {
    if (timeline.action === 'page_load') {
        return {};
    }
    var time = timeline.marks.reduce(function(map, mark) {
        if (mark.name === 'render' ||
            mark.name === 'network_send' ||
            mark.name === 'timeout_callback_done' ||
            mark.name === 'interval_callback_done' ||
            mark.name === 'request_animation_frame_callback_done') {
            map.js += mark.timestamp - map.lastJSStart;
            map.lastJSStart = mark.timestamp;
            map.total = mark.name === 'render' && mark.timestamp || map.total;
        }

        // things that begin js turns belonging to this timeline
        if (mark.name === 'network_response_end' ||
            mark.name === 'network_error') {
            map.network += mark.timestamp - map.lastJSStart;
            map.lastJSStart = mark.timestamp;
        }
        if (mark.name === 'timeout_callback' ||
            mark.name === 'interval_callback' ||
            mark.name === 'request_animation_frame_callback') {
            map.timeouts += mark.timestamp - map.lastJSStart;
            map.lastJSStart = mark.timestamp;
        }
        return map;
    }, { lastJSStart: 0, js: 0, network: 0, timeouts: 0 });
    return time;
}

function logTimeline(timeline) {
    if (timeline.action === 'page_load') {
        // return;
    }
    if (!timeline.marks.length) {
        return;
    }
    // console.log(timeline);
    console.log(
        '\n<<<<<<\tTIMELINE START  - TRIGGER:',
        timeline.action, 'timelineId',
        timeline.id,
        'DURATION',
        timeline.marks[timeline.marks.length - 1].timestamp.toFixed(2),
        'trigger components',
        timeline.components,
        'heap_used',
        timeline.heap_used
    );
    console.log(timeline.marks.reduce(function(accum, m) {
        var result = accum;
        result += '\n' + m.timestamp.toFixed(2);
        if (m.name.indexOf('network') === 0) {
            result += '\t' + m.name.toUpperCase() + '\t' + m.url;
        } else if (m.name === 'render') {
            result += '\tRENDER\t' + m.components;
        } else {
            result += '\t' + m.name.toUpperCase();
            ['delay', 'stack'].forEach(function (detailKey) {
                if(m[detailKey] !== undefined){
                   result += '\t' + detailKey + '\t' + m[detailKey];
                }
            });
        }

        return result;
    }, ''));
    console.log(
        '\n>>>>>>\tTIMELINE END  - TRIGGER:',
        timeline.action,
        'id',
        timeline.id,
        'DURATION',
        timeline.marks[timeline.marks.length - 1].timestamp,
        'trigger components',
        timeline.components
    );

    var times = analyzeTimeline(timeline);
    console.log('total js execution: ', times.js);
    console.log('total network wait: ', times.network);
    console.log('total timeout wait: ', times.timeouts);
    console.log('total time (to last render): ', times.total);
    console.log('total sum: ', times.js + times.network + times.timeouts);
}

module.exports = { logTimelines, logTimeline, analyzeTimeline };
//FOR DEBUGGING ONLY
if (window) {
    window['logTimelines'] = logTimelines;
}
