import mongoose, { type Model, type Schema } from 'mongoose';

/**
 * Mongoose keeps one global model registry per process. Compiling the same
 * model name twice throws OverwriteModelError, which happens whenever a module
 * graph is re-evaluated against an already-loaded mongoose - test runners with
 * per-file isolation, and dev-server hot reload both do this.
 *
 * Returning the existing model when one is already registered makes these
 * modules safe to import more than once.
 */
export function registerModel<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema);
}
