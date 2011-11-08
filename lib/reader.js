
module.exports = Reader

var fs = require("graceful-fs")
  , Stream = require("stream").Stream
  , inherits = require("inherits")
  , path = require("path")
  , getType = require("./get-type.js")
  , hardLinks = Reader.hardLinks = {}
  , Abstract = require("./abstract.js")

// Must do this *before* loading the child classes
inherits(Reader, Abstract)

var DirReader = require("./dir-reader.js")
  , FileReader = require("./file-reader.js")
  , LinkReader = require("./link-reader.js")
  , ProxyReader = require("./proxy-reader.js")

function Reader (props, currentStat) {
  var me = this

  if (typeof props === "string") {
    props = { path: props }
  }

  if (!props.path) {
    me.error("Must provide a path", null, true)
  }

  // polymorphism.
  // call fstream.Reader(dir) to get a DirReader object, etc.
  // Note that, unlike in the Writer case, ProxyReader is going
  // to be the *normal* state of affairs, since we rarely know
  // the type of a file prior to reading it.


  var type
    , ClassType

  if (props.type && typeof props.type === "function") {
    type = props.type
    ClassType = type
  } else {
    type = getType(props)
    ClassType = Reader
  }

  if (currentStat && !type) {
    type = getType(currentStat)
    props[type] = true
    props.type = type
  }

  switch (type) {
    case "Directory":
      ClassType = DirReader
      break

    case "Link":
      // XXX hard links are just files.
      // However, it would be good to keep track of files' dev+inode
      // and nlink values, and create a HardLinkReader that emits
      // a linkpath value of the original copy, so that the tar
      // writer can preserve them.
      // ClassType = HardLinkReader
      // break

    case "File":
      ClassType = FileReader
      break

    case "SymbolicLink":
      ClassType = LinkReader
      break

    case null:
      ClassType = ProxyReader
      break
  }

  if (!(me instanceof ClassType)) {
    return new ClassType(props)
  }

  Abstract.call(me)

  me.readable = true
  me.writable = false

  me.type = type
  me.props = props
  me.depth = props.depth = props.depth || 0
  me.parent = props.parent || null
  me.root = props.root || (props.parent && props.parent.root) || me
  me.path = props.path
  me.basename = props.basename = path.basename(props.path)
  me.dirname = props.dirname = path.dirname(props.path)

  // these have served their purpose, and are now just noisy clutter
  props.parent = props.root = null

  // console.error("\n\n\n%s setting size to", props.path, props.size)
  me.size = props.size
  me.filter = typeof props.filter === "function" ? props.filter : null
  if (props.sort === "alpha") props.sort = alphasort

  // start the ball rolling.
  // this will stat the thing, and then call me._read()
  // to start reading whatever it is.
  // console.error("calling stat", props.path, currentStat)
  me._stat(currentStat)
}

function alphasort (a, b) {
  return a === b ? 0
       : a.toLowerCase() > b.toLowerCase() ? 1
       : a.toLowerCase() < b.toLowerCase() ? -1
       : a > b ? 1
       : -1
}

Reader.prototype._stat = function (currentStat) {
  var me = this
    , props = me.props
    , stat = props.follow ? "stat" : "lstat"

  // console.error("Reader._stat", me.path, currentStat)
  if (currentStat) process.nextTick(statCb.bind(null, null, currentStat))
  else fs[stat](me.path, statCb)


  function statCb (er, props_) {
    // console.error("Reader._stat, statCb", me.path, props_, props_.nlink)
    if (er) return me.error(er)

    Object.keys(props_).forEach(function (k) {
      props[k] = props_[k]
    })

    // if it's not the expected size, then abort here.
    if (undefined !== me.size && props.size !== me.size) {
      return me.error("incorrect size")
    }
    me.size = props.size

    // special little thing for handling hardlinks.
    if (props.nlink && props.nlink > 1) {
      var k = props.dev + ":" + props.ino
      // console.error("Reader has nlink", me.path, k)
      if (!hardLinks[k]) hardLinks[k] = me.path
      else {
        // switch into hardlink mode.
        me.type = me.props.type = "Link"
        me.Link = me.props.Link = true
        me.linkpath = me.props.linkpath = hardLinks[k]
        // console.error("Hardlink detected, switching mode", me.path, me.linkpath)
        // Setting __proto__ would arguably be the "correct"
        // approach here, but that just seems too wrong.
        me._stat = me._read = LinkReader.prototype._read
      }
    }

    var type = getType(props)
    if (me.type && me.type !== type) {
      me.error("Unexpected type: " + type)
    }

    // if the filter doesn't pass, then just skip over this one.
    // still have to emit end so that dir-walking can move on.
    if (me.filter) {
      if (!me.filter()) {
        me._aborted = true
        me.emit("end")
        me.emit("_end")
        return
      }
    }

    me.emit("ready", props)

    // if it's a directory, then we'll be emitting "file" events.
    me._read()
  }
}

Reader.prototype.pipe = function (dest, opts) {
  var me = this
  if (typeof dest.add === "function") {
    // piping to a multi-compatible, and we've got directory entries.
    me.on("entry", function (entry) {
      var ret = dest.add(entry)
      if (false === ret) {
        me.pause()
      }
    })
  }

  Stream.prototype.pipe.apply(this, arguments)
}

Reader.prototype.pause = function () {
  this._paused = true
  if (this._stream) this._stream.pause()
}

Reader.prototype.resume = function () {
  this._paused = false
  if (this._stream) this._stream.resume()
  this._read()
}

Reader.prototype._read = function () {
  me.warn("Cannot read unknown type: "+me.type)
}
